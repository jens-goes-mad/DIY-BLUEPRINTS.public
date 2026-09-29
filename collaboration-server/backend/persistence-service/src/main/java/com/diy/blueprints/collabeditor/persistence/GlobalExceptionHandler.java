package com.diy.blueprints.collabeditor.persistence;

import com.diy.blueprints.collabeditor.persistence.storage.StorageException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;

/**
 * Without this, Spring Boot's default error handling swallows an
 * exception's own message into a generic "Internal Server Error" with no
 * detail at all -- found by testing (2026-09-28): loadChangesBetween's
 * deliberately clear error messages ("from revision not found", "not an
 * ancestor of to") never reached any caller, defeating the entire point of
 * throwing them instead of silently walking to the root or returning
 * something misleadingly empty.
 *
 * IllegalArgumentException/IllegalStateException are how this codebase
 * already signals "bad input or state, not an internal failure" (e.g.
 * createVersion's "version already exists", deleteVersion's master-
 * protection, now loadChangesBetween's range checks) -- mapped to 400 with
 * the real message. StorageException wraps a genuine internal failure
 * (IO/JGit); still surfaced with its message rather than hidden, matching
 * this prototype's existing no-security-hardening stance (STATE.md) --
 * revisit if this ever needs to hide internals from an untrusted caller.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

  @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
  public ResponseEntity<Map<String, String>> handleBadRequest(RuntimeException e) {
    return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
  }

  @ExceptionHandler(StorageException.class)
  public ResponseEntity<Map<String, String>> handleStorageException(StorageException e) {
    return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
  }
}
