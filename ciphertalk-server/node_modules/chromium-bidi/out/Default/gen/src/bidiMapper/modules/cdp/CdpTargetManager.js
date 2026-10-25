import { LogType } from '../../../utils/log.js';
import { BrowsingContextImpl, serializeOrigin, } from '../context/BrowsingContextImpl.js';
import { WorkerRealm } from '../script/WorkerRealm.js';
import { CdpTarget } from './CdpTarget.js';
const cdpToBidiTargetTypes = {
    service_worker: 'service-worker',
    shared_worker: 'shared-worker',
    worker: 'dedicated-worker',
};
export class CdpTargetManager {
    #browserCdpClient;
    #cdpConnection;
    #targetKeysToBeIgnoredByAutoAttach = new Set();
    #selfTargetId;
    #eventManager;
    #browsingContextStorage;
    #networkStorage;
    #bluetoothProcessor;
    #preloadScriptStorage;
    #realmStorage;
    #configStorage;
    #speculationProcessor;
    #defaultUserContextId;
    #defaultUserAgent;
    #logger;
    constructor(cdpConnection, browserCdpClient, selfTargetId, eventManager, browsingContextStorage, realmStorage, networkStorage, configStorage, bluetoothProcessor, speculationProcessor, preloadScriptStorage, defaultUserContextId, defaultUserAgent, logger) {
        this.#cdpConnection = cdpConnection;
        this.#browserCdpClient = browserCdpClient;
        this.#targetKeysToBeIgnoredByAutoAttach.add(selfTargetId);
        this.#selfTargetId = selfTargetId;
        this.#eventManager = eventManager;
        this.#browsingContextStorage = browsingContextStorage;
        this.#preloadScriptStorage = preloadScriptStorage;
        this.#networkStorage = networkStorage;
        this.#configStorage = configStorage;
        this.#bluetoothProcessor = bluetoothProcessor;
        this.#speculationProcessor = speculationProcessor;
        this.#realmStorage = realmStorage;
        this.#defaultUserContextId = defaultUserContextId;
        this.#defaultUserAgent = defaultUserAgent;
        this.#logger = logger;
        this.#setEventListeners(browserCdpClient);
        // Forward browser-level CDP events to BiDi.
        this.#setCdpEventListeners(browserCdpClient);
    }
    /**
     * Forward CDP events to BiDi at the browser level (global events) for
     * sessions not associated with a BrowsingContext (e.g. the browser session
     * and custom CDP sessions).
     */
    #setCdpEventListeners(cdpClient) {
        cdpClient.on('*', (event, params) => {
            // Skip non-CDP EventEmitter events.
            if (typeof event !== 'string') {
                return;
            }
            this.#eventManager.registerGlobalEvent({
                type: 'event',
                method: `goog:cdp.${event}`,
                params: {
                    event,
                    params,
                    session: cdpClient.sessionId,
                },
            });
        });
    }
    /**
     * This method is called for each CDP session, since this class is responsible
     * for creating and destroying all targets and browsing contexts.
     */
    #setEventListeners(cdpClient) {
        cdpClient.on('Target.attachedToTarget', (params) => {
            this.#handleAttachedToTargetEvent(params, cdpClient);
        });
        cdpClient.on('Target.detachedFromTarget', this.#handleDetachedFromTargetEvent.bind(this));
        cdpClient.on('Target.targetInfoChanged', this.#handleTargetInfoChangedEvent.bind(this));
        cdpClient.on('Inspector.targetCrashed', () => {
            this.#handleTargetCrashedEvent(cdpClient);
        });
        cdpClient.on('Page.frameAttached', this.#handleFrameAttachedEvent.bind(this));
        cdpClient.on('Page.frameSubtreeWillBeDetached', this.#handleFrameSubtreeWillBeDetached.bind(this));
    }
    #handleFrameAttachedEvent(params) {
        const parentBrowsingContext = this.#browsingContextStorage.findContext(params.parentFrameId);
        if (parentBrowsingContext !== undefined) {
            BrowsingContextImpl.create(params.frameId, params.parentFrameId, parentBrowsingContext.userContext, parentBrowsingContext.cdpTarget, this.#eventManager, this.#browsingContextStorage, this.#realmStorage, this.#configStorage, 
            // At this point, we don't know the URL of the frame yet, so it will be updated
            // later.
            'about:blank', undefined, this.#logger);
        }
    }
    #handleFrameSubtreeWillBeDetached(params) {
        this.#browsingContextStorage.findContext(params.frameId)?.dispose(true);
    }
    #handleAttachedToTargetEvent(params, parentSessionCdpClient) {
        const { sessionId, targetInfo } = params;
        const targetCdpClient = this.#cdpConnection.getCdpClient(sessionId);
        const detach = async () => {
            // Detaches and resumes the target suppressing errors.
            await targetCdpClient
                .sendCommand('Runtime.runIfWaitingForDebugger')
                .then(() => parentSessionCdpClient.sendCommand('Target.detachFromTarget', params))
                .catch((error) => this.#logger?.(LogType.debugError)?.(error));
        };
        // Do not attach to the Mapper target.
        if (this.#selfTargetId === targetInfo.targetId) {
            void detach();
            return;
        }
        // Service workers are special case because they attach to the
        // browser target and the page target (so twice per worker) during
        // the regular auto-attach and might hang if the CDP session on
        // the browser level is not detached. The logic to detach the
        // right session is handled in the switch below.
        const targetKey = targetInfo.type === 'service_worker'
            ? `${parentSessionCdpClient.sessionId}_${targetInfo.targetId}`
            : targetInfo.targetId;
        // Mapper generally only needs one session per target. If we
        // receive additional auto-attached sessions, that is very likely
        // coming from custom CDP sessions.
        if (this.#targetKeysToBeIgnoredByAutoAttach.has(targetKey)) {
            // Forward CDP events from custom sessions before leaving them untouched.
            this.#setCdpEventListeners(targetCdpClient);
            return;
        }
        this.#targetKeysToBeIgnoredByAutoAttach.add(targetKey);
        const userContext = targetInfo.browserContextId &&
            targetInfo.browserContextId !== this.#defaultUserContextId
            ? targetInfo.browserContextId
            : 'default';
        switch (targetInfo.type) {
            case 'tab': {
                // Tab targets are required only to handle page targets beneath them.
                this.#setEventListeners(targetCdpClient);
                // Auto-attach to the page target. No need in resuming tab target debugger, as it
                // should preserve the page target debugger state, and will be resumed by the page
                // target.
                void (async () => {
                    await targetCdpClient.sendCommand('Target.setAutoAttach', {
                        autoAttach: true,
                        waitForDebuggerOnStart: true,
                        flatten: true,
                    });
                })();
                return;
            }
            case 'page':
            case 'iframe': {
                const cdpTarget = this.#createCdpTarget(targetCdpClient, parentSessionCdpClient, targetInfo, userContext);
                const maybeContext = this.#browsingContextStorage.findContext(targetInfo.targetId);
                if (maybeContext && targetInfo.type === 'iframe') {
                    // OOPiF.
                    maybeContext.updateCdpTarget(cdpTarget);
                }
                else {
                    // If attaching to existing browser instance, there could be OOPiF targets. This
                    // case is handled by the `findFrameParentId` method.
                    const parentId = this.#findFrameParentId(targetInfo, parentSessionCdpClient.sessionId);
                    // New context.
                    BrowsingContextImpl.create(targetInfo.targetId, parentId, userContext, cdpTarget, this.#eventManager, this.#browsingContextStorage, this.#realmStorage, this.#configStorage, 
                    // Hack: when a new target created, CDP emits targetInfoChanged with an empty
                    // url, and navigates it to about:blank later. When the event is emitted for
                    // an existing target (reconnect), the url is already known, and navigation
                    // events will not be emitted anymore. Replacing empty url with `about:blank`
                    // allows to handle both cases in the same way.
                    // "7.3.2.1 Creating browsing contexts".
                    // https://html.spec.whatwg.org/multipage/document-sequences.html#creating-browsing-contexts
                    // TODO: check who to deal with non-null creator and its `creatorOrigin`.
                    targetInfo.url === '' ? 'about:blank' : targetInfo.url, targetInfo.openerFrameId ?? targetInfo.openerId, this.#logger);
                }
                return;
            }
            case 'service_worker':
            case 'worker': {
                const realm = this.#realmStorage.findRealm({
                    cdpSessionId: parentSessionCdpClient.sessionId,
                    sandbox: null, // Non-sandboxed realms.
                });
                // If there is no browsing context, this worker is already terminated.
                if (!realm) {
                    void detach();
                    return;
                }
                const cdpTarget = this.#createCdpTarget(targetCdpClient, parentSessionCdpClient, targetInfo, userContext);
                this.#handleWorkerTarget(cdpToBidiTargetTypes[targetInfo.type], cdpTarget, realm);
                return;
            }
            // In CDP, we only emit shared workers on the browser and not the set of
            // frames that use the shared worker. If we change this in the future to
            // behave like service workers (emits on both browser and frame targets),
            // we can remove this block and merge service workers with the above one.
            case 'shared_worker': {
                const cdpTarget = this.#createCdpTarget(targetCdpClient, parentSessionCdpClient, targetInfo, userContext);
                this.#handleWorkerTarget(cdpToBidiTargetTypes[targetInfo.type], cdpTarget);
                return;
            }
        }
        // DevTools or some other not supported by BiDi target. Just release
        // debugger and ignore them.
        void detach();
    }
    /** Try to find the parent browsing context ID for the given attached target. */
    #findFrameParentId(targetInfo, parentSessionId) {
        if (targetInfo.type !== 'iframe') {
            return null;
        }
        const parentId = targetInfo.openerFrameId ?? targetInfo.openerId;
        if (parentId !== undefined) {
            return parentId;
        }
        if (parentSessionId !== undefined) {
            return (this.#browsingContextStorage.findContextBySession(parentSessionId)
                ?.id ?? null);
        }
        return null;
    }
    #createCdpTarget(targetCdpClient, parentCdpClient, targetInfo, userContext) {
        this.#setEventListeners(targetCdpClient);
        const isFrameTarget = targetInfo.type === 'page' || targetInfo.type === 'iframe';
        if (isFrameTarget) {
            // Preload scripts only apply to window realms.
            this.#preloadScriptStorage.onCdpTargetCreated(targetInfo.targetId, userContext);
        }
        const target = CdpTarget.create(targetInfo.targetId, targetCdpClient, this.#browserCdpClient, parentCdpClient, this.#realmStorage, this.#eventManager, this.#preloadScriptStorage, this.#browsingContextStorage, this.#networkStorage, this.#configStorage, userContext, 
        // Pass the cached default User Agent to the new target.
        this.#defaultUserAgent, targetInfo.type, this.#logger);
        this.#networkStorage.onCdpTargetCreated(target);
        if (isFrameTarget) {
            this.#bluetoothProcessor.onCdpTargetCreated(target);
            this.#speculationProcessor.onCdpTargetCreated(target);
        }
        return target;
    }
    #workers = new Map();
    #handleWorkerTarget(realmType, cdpTarget, ownerRealm) {
        cdpTarget.cdpClient.on('Runtime.executionContextCreated', (params) => {
            const { uniqueId, id, origin } = params.context;
            const workerRealm = new WorkerRealm(cdpTarget.cdpClient, this.#eventManager, id, this.#logger, serializeOrigin(origin), ownerRealm ? [ownerRealm] : [], uniqueId, this.#realmStorage, realmType);
            this.#workers.set(cdpTarget.cdpSessionId, workerRealm);
        });
    }
    #handleDetachedFromTargetEvent({ sessionId, targetId, }) {
        if (targetId) {
            this.#preloadScriptStorage.find({ targetId }).map((preloadScript) => {
                preloadScript.dispose(targetId);
            });
        }
        const context = this.#browsingContextStorage.findContextBySession(sessionId);
        if (context) {
            context.dispose(true);
            return;
        }
        const worker = this.#workers.get(sessionId);
        if (worker) {
            this.#realmStorage.deleteRealms({
                cdpSessionId: worker.cdpClient.sessionId,
            });
        }
    }
    #handleTargetInfoChangedEvent(params) {
        const context = this.#browsingContextStorage.findContext(params.targetInfo.targetId);
        if (context) {
            context.onTargetInfoChanged(params);
        }
    }
    #handleTargetCrashedEvent(cdpClient) {
        // This is primarily used for service and shared workers. CDP tends to not
        // signal they closed gracefully and instead says they crashed to signal
        // they are closed.
        // Delete (rather than just dispose) the realms so a subsequent
        // `Target.detachedFromTarget` event does not dispose them a second time.
        this.#realmStorage.deleteRealms({
            cdpSessionId: cdpClient.sessionId,
        });
    }
}
//# sourceMappingURL=CdpTargetManager.js.map