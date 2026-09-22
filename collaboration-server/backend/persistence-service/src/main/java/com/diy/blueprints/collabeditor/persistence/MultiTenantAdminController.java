package com.diy.blueprints.collabeditor.persistence;

import com.diy.blueprints.collabeditor.persistence.storage.CustomerMeta;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentMeta;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentRef;
import com.diy.blueprints.collabeditor.persistence.storage.GitDocumentStorageService;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Backs the multi-tenant admin prototype UI (admin-mt.html) directly with
 * GitDocumentStorageService -- no DocumentIndexService, no
 * DocumentPersistenceCoordinator, no Postgres. Deliberately scoped this
 * way (STATE.md's RFC section): customer/document/version listing is
 * derived live from git on every request (listCustomerIds/listAllRefs),
 * which is real, verified behavior at this prototype's scale, just not
 * the fast indexed path the full RFC design eventually wants. A
 * completely separate controller from DocumentController -- the existing
 * single-tenant editor and its admin.html are untouched by this.
 */
@RestController
@RequestMapping("/api/mt")
public class MultiTenantAdminController {

  private final GitDocumentStorageService storage;

  public MultiTenantAdminController(GitDocumentStorageService storage) {
    this.storage = storage;
  }

  // -- customers --

  @GetMapping("/customers")
  public List<String> listCustomers() {
    return storage.listCustomerIds();
  }

  public record CreateCustomerRequest(String slug, String displayName) {}

  public record CreateCustomerResponse(String customerId) {}

  @PostMapping("/customers")
  public CreateCustomerResponse createCustomer(@RequestBody CreateCustomerRequest request) {
    String customerId = UUID.randomUUID().toString();
    storage.initCustomer(customerId, new CustomerMeta(customerId, request.slug(), request.displayName()));
    return new CreateCustomerResponse(customerId);
  }

  // -- documents --

  public record DocumentSummary(String docId, String language) {}

  @GetMapping("/customers/{customerId}/documents")
  public List<DocumentSummary> listDocuments(@PathVariable String customerId) {
    Set<DocumentSummary> docs = new LinkedHashSet<>();
    for (String ref : storage.listAllRefs(customerId).keySet()) {
      RefParts parts = RefParts.parse(ref);
      if (parts != null) docs.add(new DocumentSummary(parts.docId(), parts.language()));
    }
    return docs.stream().sorted((a, b) -> (a.docId() + a.language()).compareTo(b.docId() + b.language())).collect(Collectors.toList());
  }

  public record CreateDocumentRequest(String docId, String language, String title) {}

  @PostMapping("/customers/{customerId}/documents")
  public void createDocument(@PathVariable String customerId, @RequestBody CreateDocumentRequest request) {
    DocumentRef doc = new DocumentRef(customerId, request.docId(), request.language());
    storage.createDocument(doc, new DocumentMeta(request.docId(), request.language(), request.title()));
  }

  // -- versions --

  @GetMapping("/customers/{customerId}/documents/{docId}/{language}/versions")
  public List<String> listVersions(@PathVariable String customerId, @PathVariable String docId, @PathVariable String language) {
    String prefix = "refs/heads/docs/" + docId + "/" + language + "/";
    return storage.listAllRefs(customerId).keySet().stream()
        .filter(ref -> ref.startsWith(prefix))
        .map(ref -> ref.substring(prefix.length()))
        .sorted()
        .collect(Collectors.toList());
  }

  public record CreateVersionRequest(String versionName, String fromVersionName) {}

  @PostMapping("/customers/{customerId}/documents/{docId}/{language}/versions")
  public void createVersion(@PathVariable String customerId, @PathVariable String docId, @PathVariable String language,
                             @RequestBody CreateVersionRequest request) {
    DocumentRef doc = new DocumentRef(customerId, docId, language);
    storage.createVersion(doc, request.versionName(), request.fromVersionName());
  }

  @DeleteMapping("/customers/{customerId}/documents/{docId}/{language}/versions/{versionName}")
  public void deleteVersion(@PathVariable String customerId, @PathVariable String docId, @PathVariable String language,
                             @PathVariable String versionName) {
    DocumentRef doc = new DocumentRef(customerId, docId, language);
    storage.deleteVersion(doc, versionName);
  }

  /** refs/heads/docs/<docId>/<language>/<versionName> -- same parsing shape as GitReconciliationService's own RefParts. */
  private record RefParts(String docId, String language, String versionName) {
    static RefParts parse(String ref) {
      String prefix = "refs/heads/docs/";
      if (!ref.startsWith(prefix)) return null;
      String[] parts = ref.substring(prefix.length()).split("/", 3);
      if (parts.length != 3) return null;
      return new RefParts(parts[0], parts[1], parts[2]);
    }
  }
}
