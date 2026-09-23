package com.diy.blueprints.collabeditor.persistence;

import com.diy.blueprints.collabeditor.persistence.storage.CustomerMeta;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentMeta;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentRef;
import com.diy.blueprints.collabeditor.persistence.storage.GitDocumentStorageService;
import org.springframework.web.bind.annotation.*;

import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
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

  public record CustomerSummary(String customerId, String displayName) {}

  @GetMapping("/customers")
  public List<CustomerSummary> listCustomers() {
    return storage.listCustomerIds().stream()
        .map(id -> new CustomerSummary(id, storage.readCustomerMeta(id).map(CustomerMeta::displayName).orElse(id)))
        .collect(Collectors.toList());
  }

  public record CreateCustomerRequest(String customerId, String displayName) {}

  @PostMapping("/customers")
  public void createCustomer(@RequestBody CreateCustomerRequest request) {
    storage.initCustomer(request.customerId(), new CustomerMeta(request.customerId(), request.displayName()));
  }

  @DeleteMapping("/customers/{customerId}")
  public void deleteCustomer(@PathVariable String customerId) {
    storage.deleteCustomer(customerId);
  }

  // -- documents --

  @GetMapping("/customers/{customerId}/documents")
  public List<String> listDocuments(@PathVariable String customerId) {
    Set<String> docIds = new LinkedHashSet<>();
    for (String ref : storage.listAllRefs(customerId).keySet()) {
      RefParts parts = RefParts.parse(ref);
      if (parts != null) docIds.add(parts.docId());
    }
    return docIds.stream().sorted().collect(Collectors.toList());
  }

  public record CreateDocumentRequest(String docId, String title) {}

  @PostMapping("/customers/{customerId}/documents")
  public void createDocument(@PathVariable String customerId, @RequestBody CreateDocumentRequest request) {
    DocumentRef doc = new DocumentRef(customerId, request.docId());
    storage.createDocument(doc, new DocumentMeta(request.docId(), request.title()));
  }

  // -- versions --

  @GetMapping("/customers/{customerId}/documents/{docId}/versions")
  public List<String> listVersions(@PathVariable String customerId, @PathVariable String docId) {
    String prefix = "refs/heads/docs/" + docId + "/";
    return storage.listAllRefs(customerId).keySet().stream()
        .filter(ref -> ref.startsWith(prefix))
        .map(ref -> ref.substring(prefix.length()))
        .sorted()
        .collect(Collectors.toList());
  }

  public record CreateVersionRequest(String versionName, String fromVersionName) {}

  @PostMapping("/customers/{customerId}/documents/{docId}/versions")
  public void createVersion(@PathVariable String customerId, @PathVariable String docId,
                             @RequestBody CreateVersionRequest request) {
    DocumentRef doc = new DocumentRef(customerId, docId);
    storage.createVersion(doc, request.versionName(), request.fromVersionName());
  }

  @DeleteMapping("/customers/{customerId}/documents/{docId}/versions/{versionName}")
  public void deleteVersion(@PathVariable String customerId, @PathVariable String docId,
                             @PathVariable String versionName) {
    DocumentRef doc = new DocumentRef(customerId, docId);
    storage.deleteVersion(doc, versionName);
  }

  // -- languages (within a specific version) --

  @GetMapping("/customers/{customerId}/documents/{docId}/versions/{versionName}/languages")
  public List<String> listLanguages(@PathVariable String customerId, @PathVariable String docId,
                                     @PathVariable String versionName) {
    DocumentRef doc = new DocumentRef(customerId, docId);
    return storage.listLanguages(doc, versionName);
  }

  // -- content (one language within one version) -- backs the live editor,
  // wired up via collab-server's persistenceClient.loadTenantSnapshot/
  // saveTenantSnapshot. Mirrors DocumentController's single-tenant
  // load/save shape (ydoc as base64) but doesn't return markdown/changelog
  // on load -- onLoadDocument only ever needs the ydoc bytes to reconstruct
  // the live Y.Doc, same as the single-tenant path.

  public record ContentResponse(String ydoc) {}

  public record SaveContentRequest(String ydoc, String markdown, String changelog, String author) {}

  @GetMapping("/customers/{customerId}/documents/{docId}/versions/{versionName}/languages/{language}/content")
  public ContentResponse loadContent(@PathVariable String customerId, @PathVariable String docId,
                                      @PathVariable String versionName, @PathVariable String language) {
    DocumentRef doc = new DocumentRef(customerId, docId);
    return storage.load(doc, versionName, language)
        .map(bytes -> new ContentResponse(Base64.getEncoder().encodeToString(bytes)))
        .orElse(new ContentResponse(null));
  }

  @PutMapping("/customers/{customerId}/documents/{docId}/versions/{versionName}/languages/{language}/content")
  public void saveContent(@PathVariable String customerId, @PathVariable String docId,
                           @PathVariable String versionName, @PathVariable String language,
                           @RequestBody SaveContentRequest request) {
    DocumentRef doc = new DocumentRef(customerId, docId);
    byte[] contentBytes = Base64.getDecoder().decode(request.ydoc());
    storage.save(doc, versionName, language, contentBytes, request.markdown(), request.changelog(), request.author());
  }

  /** refs/heads/docs/<docId>/<versionName> -- same parsing shape as GitReconciliationService's own RefParts. */
  private record RefParts(String docId, String versionName) {
    static RefParts parse(String ref) {
      String prefix = "refs/heads/docs/";
      if (!ref.startsWith(prefix)) return null;
      String[] parts = ref.substring(prefix.length()).split("/", 2);
      if (parts.length != 2) return null;
      return new RefParts(parts[0], parts[1]);
    }
  }
}
