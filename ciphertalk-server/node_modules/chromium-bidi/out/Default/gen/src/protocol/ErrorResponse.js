import { ErrorCode } from './generated/webdriver-bidi.js';
export class Exception extends Error {
    error;
    message;
    stacktrace;
    constructor(error, message, stacktrace) {
        super();
        this.error = error;
        this.message = message;
        this.stacktrace = stacktrace;
    }
    toErrorResponse(commandId) {
        return {
            type: 'error',
            id: commandId,
            error: this.error,
            message: this.message,
            stacktrace: this.stacktrace,
        };
    }
}
export class InvalidArgumentException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.InvalidArgument, message, stacktrace);
    }
}
export class InvalidSelectorException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.InvalidSelector, message, stacktrace);
    }
}
export class InvalidSessionIdException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.InvalidSessionId, message, stacktrace);
    }
}
export class MoveTargetOutOfBoundsException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.MoveTargetOutOfBounds, message, stacktrace);
    }
}
export class NoSuchAlertException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchAlert, message, stacktrace);
    }
}
export class NoSuchElementException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchElement, message, stacktrace);
    }
}
export class NoSuchFrameException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchFrame, message, stacktrace);
    }
}
export class NoSuchHandleException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchHandle, message, stacktrace);
    }
}
export class NoSuchHistoryEntryException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchHistoryEntry, message, stacktrace);
    }
}
export class NoSuchInterceptException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchIntercept, message, stacktrace);
    }
}
export class NoSuchNodeException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchNode, message, stacktrace);
    }
}
export class NoSuchRequestException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchRequest, message, stacktrace);
    }
}
export class NoSuchScriptException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchScript, message, stacktrace);
    }
}
export class NoSuchUserContextException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchUserContext, message, stacktrace);
    }
}
export class SessionNotCreatedException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.SessionNotCreated, message, stacktrace);
    }
}
export class UnknownCommandException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.UnknownCommand, message, stacktrace);
    }
}
export class UnknownErrorException extends Exception {
    constructor(message, stacktrace = new Error().stack) {
        super(ErrorCode.UnknownError, message, stacktrace);
    }
}
export class UnableToCaptureScreenException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.UnableToCaptureScreen, message, stacktrace);
    }
}
export class UnableToCloseBrowserException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.UnableToCloseBrowser, message, stacktrace);
    }
}
export class UnsupportedOperationException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.UnsupportedOperation, message, stacktrace);
    }
}
export class NoSuchStoragePartitionException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchStoragePartition, message, stacktrace);
    }
}
export class UnableToSetCookieException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.UnableToSetCookie, message, stacktrace);
    }
}
export class UnableToSetFileInputException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.UnableToSetFileInput, message, stacktrace);
    }
}
export class UnderspecifiedStoragePartitionException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.UnderspecifiedStoragePartition, message, stacktrace);
    }
}
export class InvalidWebExtensionException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.InvalidWebExtension, message, stacktrace);
    }
}
export class NoSuchWebExtensionException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchWebExtension, message, stacktrace);
    }
}
export class NoSuchNetworkCollectorException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchNetworkCollector, message, stacktrace);
    }
}
export class NoSuchNetworkDataException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchNetworkData, message, stacktrace);
    }
}
export class UnavailableNetworkDataException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.UnavailableNetworkData, message, stacktrace);
    }
}
export class NoSuchScreencastException extends Exception {
    constructor(message, stacktrace) {
        super(ErrorCode.NoSuchScreencast, message, stacktrace);
    }
}
//# sourceMappingURL=ErrorResponse.js.map