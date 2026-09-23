package com.diy.blueprints.collabeditor.persistence;

import com.diy.blueprints.collabeditor.persistence.storage.DocumentMeta;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentRef;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentStorageService;
import org.springframework.web.bind.annotation.*;

import java.util.Base64;
import java.util.List;

/**
 * The tenant-scoped content API a real editing session uses once
 * authenticated (JWT/Keycloak resolves customerId; the client already
 * knows which document/version/language it has open, same as the
 * "mt:" room-name convention already carries today) -- documents,
 * versions, languages, content, and history, all scoped to a customerId
 * the caller already has. DocumentStorageService only: no git type
 * crosses this boundary (see that interface's own javadoc), so this
 * controller has no idea git is the implementation underneath, and every
 * method here has a real interface method behind it -- nothing
 * git-specific-only (like reading raw customer metadata, or enumerating/
 * deleting whole customers) lives here.
 *
 * Distinct on purpose from MultiTenantAdminController, which keeps only
 * customer *lifecycle* (list/create/delete a customer) -- a platform/ops
 * concern a regular user's JWT would never authorize, unlike everything
 * on this controller.
 */
@RestController
@RequestMapping("/api/mt")
public class DocumentController {

  private final DocumentStorageService storage;

  public DocumentController(DocumentStorageService storage) {
    this.storage = storage;
  }

  // -- documents --

  @GetMapping("/customers/{customerId}/documents")
  public List<String> listDocuments(@PathVariable String customerId) {
    return storage.listDocuments(customerId);
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
    return storage.listVersions(new DocumentRef(customerId, docId));
  }

  public record CreateVersionRequest(String versionName, String fromVersionName) {}

  @PostMapping("/customers/{customerId}/documents/{docId}/versions")
  public void createVersion(@PathVariable String customerId, @PathVariable String docId,
                             @RequestBody CreateVersionRequest request) {
    storage.createVersion(new DocumentRef(customerId, docId), request.versionName(), request.fromVersionName());
  }

  @DeleteMapping("/customers/{customerId}/documents/{docId}/versions/{versionName}")
  public void deleteVersion(@PathVariable String customerId, @PathVariable String docId,
                             @PathVariable String versionName) {
    storage.deleteVersion(new DocumentRef(customerId, docId), versionName);
  }

  public record MergeBaseResponse(String commitId) {}

  @GetMapping("/customers/{customerId}/documents/{docId}/versions/merge-base")
  public MergeBaseResponse mergeBase(@PathVariable String customerId, @PathVariable String docId,
                                      @RequestParam String a, @RequestParam String b) {
    DocumentRef doc = new DocumentRef(customerId, docId);
    return new MergeBaseResponse(storage.findMergeBase(doc, a, b));
  }

  // -- languages --

  @GetMapping("/customers/{customerId}/documents/{docId}/versions/{versionName}/languages")
  public List<String> listLanguages(@PathVariable String customerId, @PathVariable String docId,
                                     @PathVariable String versionName) {
    return storage.listLanguages(new DocumentRef(customerId, docId), versionName);
  }

  // -- content (one language within one version) -- backs the live editor,
  // wired up via collab-server's persistenceClient.loadSnapshot/
  // saveSnapshot. Doesn't return markdown on load -- onLoadDocument
  // only ever needs the ydoc bytes to reconstruct the live Y.Doc; markdown
  // is a derived, write-only artifact kept purely for human-readable diffs
  // (see README), never read back by any real caller.

  public record ContentResponse(String ydoc) {}

  public record SaveContentRequest(String ydoc, String markdown, String changelog, String author) {}

  @GetMapping("/customers/{customerId}/documents/{docId}/versions/{versionName}/languages/{language}/content")
  public ContentResponse load(@PathVariable String customerId, @PathVariable String docId,
                               @PathVariable String versionName, @PathVariable String language) {
    DocumentRef doc = new DocumentRef(customerId, docId);
    return storage.load(doc, versionName, language)
        .map(bytes -> new ContentResponse(Base64.getEncoder().encodeToString(bytes)))
        .orElse(new ContentResponse(null));
  }

  @PutMapping("/customers/{customerId}/documents/{docId}/versions/{versionName}/languages/{language}/content")
  public void save(@PathVariable String customerId, @PathVariable String docId,
                    @PathVariable String versionName, @PathVariable String language,
                    @RequestBody SaveContentRequest request) {
    DocumentRef doc = new DocumentRef(customerId, docId);
    byte[] contentBytes = Base64.getDecoder().decode(request.ydoc());
    storage.save(doc, versionName, language, contentBytes, request.markdown(), request.changelog(), request.author());
  }

  @GetMapping("/customers/{customerId}/documents/{docId}/versions/{versionName}/languages/{language}/changelog")
  public String changelog(@PathVariable String customerId, @PathVariable String docId,
                           @PathVariable String versionName, @PathVariable String language) {
    return storage.loadChangelog(new DocumentRef(customerId, docId), versionName, language);
  }

  @GetMapping("/customers/{customerId}/documents/{docId}/versions/{versionName}/languages/{language}/history")
  public List<BlameLine> history(@PathVariable String customerId, @PathVariable String docId,
                                  @PathVariable String versionName, @PathVariable String language) {
    return storage.history(new DocumentRef(customerId, docId), versionName, language);
  }

  // -- merge --

  public record MergeRequest(String sourceVersionName, String language, String ydoc, String markdown, String author) {}

  @PostMapping("/customers/{customerId}/documents/{docId}/versions/{targetVersionName}/merge")
  public MergeOutcome merge(@PathVariable String customerId, @PathVariable String docId,
                             @PathVariable String targetVersionName, @RequestBody MergeRequest request) {
    DocumentRef doc = new DocumentRef(customerId, docId);
    byte[] mergedContentBytes = Base64.getDecoder().decode(request.ydoc());
    return storage.merge(doc, request.sourceVersionName(), targetVersionName, request.language(),
        mergedContentBytes, request.markdown(), request.author());
  }
}
