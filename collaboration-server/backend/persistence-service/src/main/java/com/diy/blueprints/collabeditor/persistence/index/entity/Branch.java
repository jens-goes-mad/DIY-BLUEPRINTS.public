package com.diy.blueprints.collabeditor.persistence.index.entity;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * gitRef is self-describing on purpose (refs/heads/docs/<docId>/<language>/
 * <versionName>) -- "branches of a doc" stays answerable directly from git
 * as a defense-in-depth check against this table, not solely from
 * Postgres. headCommitSha is a cache of git's actual ref tip, kept in sync
 * by DocumentPersistenceCoordinator on every write and self-healed by
 * GitReconciliationService if it ever drifts.
 */
@Entity
@Table(name = "branches", uniqueConstraints = @UniqueConstraint(columnNames = {"documentId", "versionName"}))
public class Branch {

  @Id
  @GeneratedValue
  private UUID id;

  @Column(nullable = false)
  private UUID documentId;

  @Column(nullable = false)
  private String versionName;

  @Column(nullable = false)
  private String gitRef;

  @Column(nullable = false)
  private boolean isDefault = false;

  private String headCommitSha;

  private String createdBy;

  @Column(nullable = false)
  private Instant createdAt = Instant.now();

  @Column(nullable = false)
  private Instant updatedAt = Instant.now();

  protected Branch() {
    // JPA
  }

  public Branch(UUID documentId, String versionName, String gitRef, boolean isDefault, String createdBy) {
    this.documentId = documentId;
    this.versionName = versionName;
    this.gitRef = gitRef;
    this.isDefault = isDefault;
    this.createdBy = createdBy;
  }

  public UUID getId() { return id; }
  public UUID getDocumentId() { return documentId; }
  public String getVersionName() { return versionName; }
  public String getGitRef() { return gitRef; }
  public boolean isDefault() { return isDefault; }
  public String getHeadCommitSha() { return headCommitSha; }
  public void setHeadCommitSha(String sha) { this.headCommitSha = sha; this.updatedAt = Instant.now(); }
  public String getCreatedBy() { return createdBy; }
  public Instant getCreatedAt() { return createdAt; }
  public Instant getUpdatedAt() { return updatedAt; }
}
