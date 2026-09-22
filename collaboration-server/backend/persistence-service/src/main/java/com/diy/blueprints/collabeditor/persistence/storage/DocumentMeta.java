package com.diy.blueprints.collabeditor.persistence.storage;

/**
 * Written once, as <docId>.meta.json, when a document is created (see
 * GitDocumentStorageService.writeDocumentMeta). Every branch forked
 * afterward inherits this file automatically via ordinary git ancestry, so
 * reconciliation can recover full document identity -- including title,
 * which nothing in the ref naming scheme itself carries -- from any
 * branch's tip tree alone. Deliberately treated as immutable: a title
 * rename is a hypothetical future feature, not a current need (see
 * STATE.md's RFC section).
 */
public record DocumentMeta(String docId, String language, String title) {
}
