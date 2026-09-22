package com.diy.blueprints.collabeditor.persistence.storage;

/**
 * Unchecked on purpose -- see DocumentStorageService's javadoc for why
 * none of its methods declare a checked exception. Wraps whatever the
 * underlying implementation's actual failure was (an I/O error, a git
 * operation failure, ...); callers that can't meaningfully recover from a
 * storage failure (most of them) don't have to declare or catch anything
 * they're only going to propagate anyway.
 */
public class StorageException extends RuntimeException {
  public StorageException(String message, Throwable cause) {
    super(message, cause);
  }
}
