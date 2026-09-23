package com.diy.blueprints.collabeditor.persistence.storage;

/**
 * Identifies a single document: which customer, which document. Language
 * is deliberately NOT part of this identity (revised from an earlier
 * design -- see STATE.md's RFC section for the reasoning): a version
 * (branch) is a unit of change that starts in one language and picks up
 * translations incrementally over time, all within the same branch, until
 * it's complete enough to merge to master. Language is a parameter
 * alongside versionName on the content methods (load/save/merge)
 * instead -- which language, within this version's tree -- not a
 * separate branch namespace.
 */
public record DocumentRef(String customerId, String docId) {
}
