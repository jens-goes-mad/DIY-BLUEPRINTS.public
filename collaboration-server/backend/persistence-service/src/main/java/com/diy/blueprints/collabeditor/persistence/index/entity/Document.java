package com.diy.blueprints.collabeditor.persistence.index.entity;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * Document identity includes language on purpose: ("onboarding-guide",
 * "en") and ("onboarding-guide", "de") are independent documents with
 * independent branch histories, not two branches of one document -- see
 * STATE.md's RFC section for the reasoning (and the flagged assumption).
 */
@Entity
@Table(name = "documents", uniqueConstraints = @UniqueConstraint(columnNames = {"customerId", "docId", "language"}))
public class Document {

  @Id
  @GeneratedValue
  private UUID id;

  @Column(nullable = false)
  private UUID customerId;

  @Column(nullable = false)
  private String docId;

  @Column(nullable = false)
  private String language;

  private String title;

  @Column(nullable = false)
  private Instant createdAt = Instant.now();

  @Column(nullable = false)
  private Instant updatedAt = Instant.now();

  protected Document() {
    // JPA
  }

  public Document(UUID customerId, String docId, String language, String title) {
    this.customerId = customerId;
    this.docId = docId;
    this.language = language;
    this.title = title;
  }

  public UUID getId() { return id; }
  public UUID getCustomerId() { return customerId; }
  public String getDocId() { return docId; }
  public String getLanguage() { return language; }
  public String getTitle() { return title; }
  public Instant getCreatedAt() { return createdAt; }
  public Instant getUpdatedAt() { return updatedAt; }
  public void touch() { this.updatedAt = Instant.now(); }
}
