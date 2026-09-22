package com.diy.blueprints.collabeditor.persistence.index;

import com.diy.blueprints.collabeditor.persistence.index.entity.Branch;
import com.diy.blueprints.collabeditor.persistence.index.entity.Customer;
import com.diy.blueprints.collabeditor.persistence.index.entity.Document;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Postgres-backed queries and writes (RFC: multi-tenant scale, STATE.md).
 * The only thing that touches CustomerRepository/DocumentRepository/
 * BranchRepository/OutboxRepository directly -- everything else (reads
 * from controllers, writes from DocumentPersistenceCoordinator,
 * corrections from GitReconciliationService) goes through this facade.
 *
 * Read methods are called directly by controllers, bypassing
 * DocumentPersistenceCoordinator entirely -- a list/search request never
 * needs to touch git. Write methods are called only by the coordinator
 * (after the corresponding git write already succeeded) and by
 * GitReconciliationService (correcting drift found by diffing against git's
 * actual ref state) -- never by a controller directly, so the "git first,
 * index second" ordering rule has exactly one place it can be violated
 * from, not every call site.
 */
public interface DocumentIndexService {

  // -- reads --
  List<Customer> listCustomers();
  Optional<Customer> getCustomer(UUID customerId);
  List<Document> listDocuments(UUID customerId, String languageOrNull);
  Optional<Document> getDocument(UUID customerId, String docId, String language);
  List<Branch> listBranches(UUID documentId);

  // -- writes: each also records an outbox_events row in the same
  // transaction, the durable-retry fast path described on OutboxEvent --
  Customer upsertCustomer(Customer customer);
  Document upsertDocument(Document document);
  Branch upsertBranch(Branch branch);
  void deleteVersion(UUID documentId, String versionName);
}
