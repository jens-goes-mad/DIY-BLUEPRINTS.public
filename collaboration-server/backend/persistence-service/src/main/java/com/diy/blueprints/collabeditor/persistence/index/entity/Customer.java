package com.diy.blueprints.collabeditor.persistence.index.entity;

import jakarta.persistence.*;
import org.springframework.data.domain.Persistable;

import java.time.Instant;

/**
 * Postgres query index (RFC: multi-tenant scale, STATE.md) -- NOT the
 * source of truth. Git is authoritative (see GitDocumentStorageService);
 * this table exists purely so "list customers"/"docs for a customer"/
 * "versions for a customer" are fast joins instead of a git ref scan.
 * Fully rebuildable from git via the reconciliation sweep and each repo's
 * _customer.meta.json (CustomerMeta) -- see GitReconciliationService.
 *
 * id is itself the readable, git-URL-friendly slug (e.g. "acme-corp") --
 * also the repo's actual directory name on disk, reposRoot/<id>.git, with
 * no separate slug field and no sharding (see
 * GitDocumentStorageService's javadoc: sharding by a readable name's
 * leading characters clusters badly, unlike a UUID's uniform randomness).
 * repoPath isn't stored either -- trivially derivable from id alone now
 * that there's no sharding to compute.
 *
 * Implements Persistable&lt;String&gt; because the id is client-assigned
 * (the caller picks the slug), not @GeneratedValue -- without this,
 * Spring Data JPA's default "is this a new row?" check (id == null)
 * always sees a non-null id and assumes UPDATE, so the very first save()
 * of a brand-new customer would incorrectly try to update a row that
 * doesn't exist yet instead of inserting one. isNew() here makes that
 * explicit instead of relying on Hibernate's merge-on-missing-row
 * fallback behavior.
 */
@Entity
@Table(name = "customers")
public class Customer implements Persistable<String> {

  public enum Status { PROVISIONING, READY, ARCHIVED }

  @Id
  private String id;

  @Transient
  private boolean isNewEntity = true;

  @Column(nullable = false)
  private String displayName;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false)
  private Status status = Status.PROVISIONING;

  @Column(nullable = false)
  private Instant createdAt = Instant.now();

  protected Customer() {
    // JPA
  }

  public Customer(String id, String displayName) {
    this.id = id;
    this.displayName = displayName;
  }

  @Override
  public String getId() { return id; }
  public String getDisplayName() { return displayName; }
  public Status getStatus() { return status; }
  public void setStatus(Status status) { this.status = status; }
  public Instant getCreatedAt() { return createdAt; }

  @Override
  public boolean isNew() { return isNewEntity; }

  @PostLoad
  @PostPersist
  void markNotNew() { this.isNewEntity = false; }
}
