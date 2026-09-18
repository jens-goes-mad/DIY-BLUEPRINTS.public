package com.diy.blueprints.collabeditor.persistence;

public record MergeOutcome(boolean merged, String status, String commitId, int parentCount) {
}
