package com.diy.blueprints.collabeditor.persistence;

public record BlameLine(int lineNumber, String content, String author, String commitId, String committedAt) {
}
