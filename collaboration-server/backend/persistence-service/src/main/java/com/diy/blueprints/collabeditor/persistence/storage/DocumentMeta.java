package com.diy.blueprints.collabeditor.persistence.storage;

/**
 * Written once, as <docId>/meta.json (document-level, not under any
 * language subdirectory -- see DocumentRef's javadoc for why language
 * isn't part of document identity), when a document is created. Every
 * version forked afterward inherits this file automatically via ordinary
 * git ancestry, so reconciliation can recover full document identity --
 * including title, which nothing in the ref naming scheme itself carries
 * -- from any version's tip tree alone. Deliberately treated as
 * immutable: a title rename is a hypothetical future feature, not a
 * current need (see STATE.md's RFC section).
 */
public record DocumentMeta(String docId, String title) {
}
