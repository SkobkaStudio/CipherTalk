/**
 * Copyright 2026 Google LLC.
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
export const ErrorCode = {
    InvalidArgument: 'invalid argument',
    InvalidSelector: 'invalid selector',
    InvalidSessionId: 'invalid session id',
    InvalidWebExtension: 'invalid web extension',
    MoveTargetOutOfBounds: 'move target out of bounds',
    NoSuchAlert: 'no such alert',
    NoSuchNetworkCollector: 'no such network collector',
    NoSuchElement: 'no such element',
    NoSuchFrame: 'no such frame',
    NoSuchHandle: 'no such handle',
    NoSuchHistoryEntry: 'no such history entry',
    NoSuchIntercept: 'no such intercept',
    NoSuchNetworkData: 'no such network data',
    NoSuchNode: 'no such node',
    NoSuchRequest: 'no such request',
    NoSuchScreencast: 'no such screencast',
    NoSuchScript: 'no such script',
    NoSuchStoragePartition: 'no such storage partition',
    NoSuchUserContext: 'no such user context',
    NoSuchWebExtension: 'no such web extension',
    SessionNotCreated: 'session not created',
    UnableToCaptureScreen: 'unable to capture screen',
    UnableToCloseBrowser: 'unable to close browser',
    UnableToSetCookie: 'unable to set cookie',
    UnableToSetFileInput: 'unable to set file input',
    UnavailableNetworkData: 'unavailable network data',
    UnderspecifiedStoragePartition: 'underspecified storage partition',
    UnknownCommand: 'unknown command',
    UnknownError: 'unknown error',
    UnsupportedOperation: 'unsupported operation',
};
export var Session;
(function (Session) {
    Session.UserPromptHandlerType = {
        Accept: 'accept',
        Dismiss: 'dismiss',
        Ignore: 'ignore',
    };
})(Session || (Session = {}));
export var BrowsingContext;
(function (BrowsingContext) {
    BrowsingContext.ReadinessState = {
        None: 'none',
        Interactive: 'interactive',
        Complete: 'complete',
    };
})(BrowsingContext || (BrowsingContext = {}));
(function (BrowsingContext) {
    BrowsingContext.UserPromptType = {
        Alert: 'alert',
        Beforeunload: 'beforeunload',
        Confirm: 'confirm',
        Prompt: 'prompt',
    };
})(BrowsingContext || (BrowsingContext = {}));
(function (BrowsingContext) {
    BrowsingContext.CreateType = { Tab: 'tab', Window: 'window' };
})(BrowsingContext || (BrowsingContext = {}));
export var Emulation;
(function (Emulation) {
    Emulation.ForcedColorsModeTheme = { Light: 'light', Dark: 'dark' };
})(Emulation || (Emulation = {}));
(function (Emulation) {
    Emulation.ScreenOrientationNatural = {
        Portrait: 'portrait',
        Landscape: 'landscape',
    };
})(Emulation || (Emulation = {}));
(function (Emulation) {
    Emulation.ScreenOrientationType = {
        PortraitPrimary: 'portrait-primary',
        PortraitSecondary: 'portrait-secondary',
        LandscapePrimary: 'landscape-primary',
        LandscapeSecondary: 'landscape-secondary',
    };
})(Emulation || (Emulation = {}));
export var Network;
(function (Network) {
    Network.SameSite = {
        Strict: 'strict',
        Lax: 'lax',
        None: 'none',
        Default: 'default',
    };
})(Network || (Network = {}));
(function (Network) {
    Network.DataType = { Request: 'request', Response: 'response' };
})(Network || (Network = {}));
(function (Network) {
    Network.InterceptPhase = {
        BeforeRequestSent: 'beforeRequestSent',
        ResponseStarted: 'responseStarted',
        AuthRequired: 'authRequired',
    };
})(Network || (Network = {}));
export var Script;
(function (Script) {
    Script.RealmType = {
        Window: 'window',
        DedicatedWorker: 'dedicated-worker',
        SharedWorker: 'shared-worker',
        ServiceWorker: 'service-worker',
        Worker: 'worker',
        PaintWorklet: 'paint-worklet',
        AudioWorklet: 'audio-worklet',
        Worklet: 'worklet',
    };
})(Script || (Script = {}));
(function (Script) {
    Script.ResultOwnership = { Root: 'root', None: 'none' };
})(Script || (Script = {}));
export var Log;
(function (Log) {
    Log.Level = {
        Debug: 'debug',
        Info: 'info',
        Warn: 'warn',
        Error: 'error',
    };
})(Log || (Log = {}));
export var Input;
(function (Input) {
    Input.PointerType = {
        Mouse: 'mouse',
        Pen: 'pen',
        Touch: 'touch',
    };
})(Input || (Input = {}));
//# sourceMappingURL=webdriver-bidi.js.map