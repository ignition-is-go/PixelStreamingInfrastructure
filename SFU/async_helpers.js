function runSafely(label, operation, logger = console, onError) {
    return Promise.resolve()
        .then(operation)
        .catch((error) => {
            logger.error(`${label}: ${error.stack || error.message}`);
            if (onError) {
                try {
                    onError(error);
                } catch (callbackError) {
                    logger.error(`${label} cleanup failed: ${callbackError.stack || callbackError.message}`);
                }
            }
            return undefined;
        });
}

module.exports = { runSafely };
