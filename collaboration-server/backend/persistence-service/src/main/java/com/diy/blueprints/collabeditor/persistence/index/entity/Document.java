package com.diy.blueprints.collabeditor.persistence.index.entity;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * Document identity is (customerId, docId) only -- language is
 * deliberately NOT part of it (revised design -- see DocumentRef's
 * javadoc): a version (branch) is a unit of change that may touch
 * several languages over its lifetime, all within the same version, so
 * language is a property of what a version's tree currently contains,
 * not of which document/branch history it belongs to.
 */
@Entity
@Table(name = "documents", uniqueConstraints = @UniqueConstraint(columnNames = {"customerId", "docId"}))
public class Document {

  @Id
  @GeneratedValue
  private UUID id;

  @Column(nullable = false)
  private String customerId;

  @Column(nullable = false)
  private String docId;

  private String title;

  @Column(nullable = false)
  private Instant createdAt = Instant.now();

  @Column(nullable = false)
  private Instant updatedAt = Instant.now();

  protected Document() {
    // JPA
  }

  public Document(String customerId, String docId, String title) {
    this.customerId = customerId;
    this.docId = docId;
    this.title = title;
  }

  public UUID getId() { return id; }
  public String getCustomerId() { return customerId; }
  public String getDocId() { return docId; }
  public String getTitle() { return title; }
  public Instant getCreatedAt() { return createdAt; }
  public Instant getUpdatedAt() { return updatedAt; }
  public void touch() { this.updatedAt = Instant.now(); }
}
