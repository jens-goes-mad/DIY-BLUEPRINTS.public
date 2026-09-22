package com.diy.blueprints.collabeditor.persistence.index.entity;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;

/**
 * The outbox pattern's durable retry record (RFC: multi-tenant scale,
 * STATE.md) -- NOT written on every successful index write (see
 * DocumentIndexServiceImpl's javadoc for why that would make this table
 * pointless), only when the direct entity write throws. OutboxWorker polls
 * pending rows and retries applying them, idempotently (upserts keyed the
 * same way the unique constraints on Document/Branch are), so at-least-
 * once delivery needs no separate dedup logic. Not the ultimate guarantee
 * either: if Postgres is unreachable at the exact instant of the git
 * write, both the direct write AND this row's insert fail together, and
 * the periodic GitReconciliationService (which derives everything from git's
 * own ref state, not from this table) is what actually closes that gap.
 */
@Entity
@Table(name = "outbox_events")
public class OutboxEvent {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @Column(nullable = false)
  private String eventType; // "branch_upserted" | "branch_deleted" | "document_upserted" | "customer_upserted"

  @JdbcTypeCode(SqlTypes.JSON)
  @Column(nullable = false, columnDefinition = "jsonb")
  private String payload; // JSON blob; OutboxWorker deserializes based on eventType

  @Column(nullable = false)
  private Instant createdAt = Instant.now();

  private Instant processedAt; // null = still pending

  @Column(nullable = false)
  private int attempts = 0;

  private String lastError;

  protected OutboxEvent() {
    // JPA
  }

  public OutboxEvent(String eventType, String payload) {
    this.eventType = eventType;
    this.payload = payload;
  }

  public Long getId() { return id; }
  public String getEventType() { return eventType; }
  public String getPayload() { return payload; }
  public Instant getCreatedAt() { return createdAt; }
  public Instant getProcessedAt() { return processedAt; }
  public boolean isPending() { return processedAt == null; }
  public void markProcessed() { this.processedAt = Instant.now(); }
  public int getAttempts() { return attempts; }
  public void recordFailure(String error) { this.attempts += 1; this.lastError = error; }
  public String getLastError() { return lastError; }
}
