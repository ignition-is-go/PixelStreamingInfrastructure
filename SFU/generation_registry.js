class GenerationRegistry {
    constructor() {
        this.current = null;
        this.pending = null;
        this.nextGeneration = 0;
    }

    begin(value) {
        if (this.current !== null || this.pending !== null) {
            return null;
        }
        value.generation = ++this.nextGeneration;
        this.pending = value;
        return value;
    }

    activate(value) {
        if (this.pending !== value) {
            return false;
        }
        this.pending = null;
        this.current = value;
        return true;
    }

    cancelPending() {
        const value = this.pending;
        this.pending = null;
        return value;
    }

    clearCurrent(value = this.current) {
        if (this.current !== value) {
            return false;
        }
        this.current = null;
        return true;
    }

    isCurrent(value) {
        return this.current === value;
    }
}

module.exports = { GenerationRegistry };
