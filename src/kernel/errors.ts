export class InsufficientMemoryError extends Error {
  readonly requestedBytes: number;
  readonly availableBytes: number;
  constructor(requestedBytes: number, availableBytes: number, message?: string) {
    super(
      message ??
        `insufficient canvas memory: needed ${requestedBytes} bytes, only ${Math.max(
          0,
          availableBytes
        )} bytes available in the tile budget`
    );
    this.name = 'InsufficientMemoryError';
    this.requestedBytes = requestedBytes;
    this.availableBytes = availableBytes;
  }
}

export class StorageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'StorageError';
  }
}

export class CommitAbortedError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'CommitAbortedError';
  }
}

export class OutOfMemoryForEditError extends Error {
  constructor(
    readonly plannedTiles: number,
    readonly stagedTiles: number,
    message: string
  ) {
    super(message);
    this.name = 'OutOfMemoryForEditError';
  }
}

export class BudgetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetConfigError';
  }
}
