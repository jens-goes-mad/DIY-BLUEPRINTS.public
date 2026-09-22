package com.diy.blueprints.collabeditor.persistence.index.entity;

import jakarta.persistence.*;
import org.springframework.data.domain.Persistable;

import java.time.Instant;
import java.util.UUID;

/**
 * Postgres query index (RFC: multi-tenant scale, STATE.md) -- NOT the
 * source of truth. Git is authoritative (see GitDocumentStorageService);
 * this table exists purely so "list customers"/"docs for a customer"/
 * "branches for a customer" are fast joins instead of a git ref scan.
 * Fully rebuildable from git via the reconciliation sweep and each repo's
 * _customer.meta.json (CustomerMeta) -- see GitReconciliationService.
 *
 * Implements Persistable&lt;UUID&gt; because the id is client-assigned
 * (see below), not @GeneratedValue -- without this, Spring Data JPA's
 * default "is this a new row?" check (id == null) always sees a non-null
 * id and assumes UPDATE, so the very first save() of a brand-new customer
 * would incorrectly try to update a row that doesn't exist yet instead of
 * inserting one. isNew() here makes that explicit instead of relying on
 * Hibernate's merge-on-missing-row fallback behavior.
 */
@Entity
@Table(name = "customers")
public class Customer implements Persistable<UUID> {

  public enum Status { PROVISIONING, READY, ARCHIVED }

  // Client-assigned, not @GeneratedValue: the coordinator needs the id
  // before the first save, to derive the storage path passed to
  // DocumentStorageService.initCustomer -- a DB-generated id would only
  // exist after that save already happened. A random UUID collision is
  // astronomically unlikely at any scale this RFC targets.
  @Id
  private UUID id;

  @Transient
  private boolean isNewEntity = true;

  @Column(nullable = false, unique = true)
  private String slug;

  @Column(nullable = false)
  private String displayName;

  @Column(nullable = false, unique = true)
  private String repoPath;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false)
  private Status status = Status.PROVISIONING;

  @Column(nullable = false)
  private Instant createdAt = Instant.now();

  protected Customer() {
    // JPA
  }

  public Customer(UUID id, String slug, String displayName, String repoPath) {
    this.id = id;
    this.slug = slug;
    this.displayName = displayName;
    this.repoPath = repoPath;
  }

  @Override
  public UUID getId() { return id; }
  public String getSlug() { return slug; }
  public String getDisplayName() { return displayName; }
  public String getRepoPath() { return repoPath; }
  public Status getStatus() { return status; }
  public void setStatus(Status status) { this.status = status; }
  public Instant getCreatedAt() { return createdAt; }

  @Override
  public boolean isNew() { return isNewEntity; }

  @PostLoad
  @PostPersist
  void markNotNew() { this.isNewEntity = false; }
}
