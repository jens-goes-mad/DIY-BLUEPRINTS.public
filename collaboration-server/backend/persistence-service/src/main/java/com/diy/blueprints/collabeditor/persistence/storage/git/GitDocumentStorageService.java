package com.diy.blueprints.collabeditor.persistence.storage.git;

import com.diy.blueprints.collabeditor.persistence.BlameLine;
import com.diy.blueprints.collabeditor.persistence.MergeOutcome;
import com.diy.blueprints.collabeditor.persistence.storage.CustomerMeta;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentMeta;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentRef;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentStorageService;
import com.diy.blueprints.collabeditor.persistence.storage.StorageException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.blame.BlameResult;
import org.eclipse.jgit.diff.RawText;
import org.eclipse.jgit.dircache.DirCache;
import org.eclipse.jgit.dircache.DirCacheBuilder;
import org.eclipse.jgit.dircache.DirCacheEntry;
import org.eclipse.jgit.lib.*;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.revwalk.filter.RevFilter;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * The one real implementation of DocumentStorageService: one bare-in-spirit
 * git repo per customer (RFC: multi-tenant scale, STATE.md), directly at
 * <reposRoot>/<customerId>.git -- customerId is itself a readable,
 * git-URL-friendly slug (e.g. "acme-corp"), not a UUID, so the repo
 * listing on disk is human-legible; no sharding, since sharding by a
 * readable name's leading characters would cluster badly (company names
 * aren't uniformly distributed the way random IDs are), and a flat
 * directory of a few hundred repos is fine on any modern filesystem. Never
 * touches a working tree/index -- pure object-database plumbing throughout
 * (see buildTreeWithOverride/commit/updateBranchRef below), which is what
 * lets concurrent saves across different customers/documents/versions
 * never race over a checkout. This class used to coexist with a separate
 * single-repo GitRepositoryService (retired 2026-09-24 once DocumentController
 * became customerId-aware and every caller could route through here
 * instead -- see STATE.md); the working-tree-avoidance discipline traces
 * back to a real incident on that single-repo predecessor: an earlier
 * merge() implementation used JGit's checkout-based MergeCommand and
 * silently dropped unrelated files from the resulting commit's tree.
 *
 * A version (branch) is a unit of change that may touch several languages
 * over its lifetime, not a per-language branch namespace -- see
 * DocumentRef's javadoc for the full reasoning. Concretely: refs are
 * refs/heads/docs/<docId>/<versionName> (no language segment), and the
 * tree layout is <docId>/meta.json (document-level identity) plus
 * <docId>/<language>/{content.ydoc,content.md,changelog.jsonl} for
 * however many languages that version's tree currently has -- which can
 * differ commit to commit as translations land incrementally.
 *
 * This is also where every git-specific detail behind the interface's
 * generic contract actually lives, kept out of DocumentStorageService's
 * own javadoc on purpose: no JGit type may appear in that interface, so a
 * fake in-memory implementation can back unit tests for merge/conflict
 * logic without a real git repo on disk, and callers never need to know
 * or care that git is the implementation underneath. Concretely:
 * initCustomer() is a git init plus a commit recording CustomerMeta;
 * createDocument() is one commit seeding an empty master version plus
 * DocumentMeta, in the same tree -- both fold what used to be two
 * separately-callable primitives (init/createVersion and a standalone meta
 * write) into one, since a caller never legitimately wants one without
 * the other, and exposing them separately only invited leaking *how* git
 * durably records identity (a file every branch inherits via ordinary
 * ancestry) as if that were itself a generic operation. readCustomerMeta(),
 * readDocumentMeta(), listCustomerIds(), listAllRefs(), and
 * deleteCustomer(), below, are deliberately NOT part of DocumentStorageService
 * -- reading raw customer/document metadata and enumerating/deleting whole
 * customers really are git-specific (or at least implementation-specific)
 * admin operations, unlike listDocuments/listVersions/history/
 * findMergeBase, which moved onto the interface itself (see its own
 * javadoc) since those questions aren't git-specific, just currently
 * git-answered. Their only consumers -- GitReconciliationService and the
 * customer-lifecycle endpoints on MultiTenantAdminController -- already
 * depend on this concrete class rather than the generic interface.
 *
 * Every public method here funnels its body through unchecked() below,
 * which turns whatever checked exception JGit/Jackson/java.io actually
 * throws into a StorageException -- matches DocumentStorageService's own
 * javadoc on why the interface declares no checked exception. A
 * RuntimeException already thrown deliberately inside a method body (e.g.
 * "version already exists") passes through unwrapped; only genuine
 * checked failures get wrapped.
 *
 * The one storage implementation in the whole app: DocumentController (the
 * live editor's request path), MultiTenantAdminController (customer
 * lifecycle), and GitReconciliationService all depend on this class (the
 * first two through the generic DocumentStorageService interface where
 * possible, the latter two directly for the git-specific extras below).
 */
@Service
public class GitDocumentStorageService implements DocumentStorageService {

  private static final ObjectMapper JSON = new ObjectMapper();

  private final Path reposRoot;

  public GitDocumentStorageService(@Value("${repos.root:/data/repos}") String reposRoot) {
    this.reposRoot = Path.of(reposRoot);
  }

  @FunctionalInterface
  private interface CheckedSupplier<T> {
    T get() throws Exception;
  }

  @FunctionalInterface
  private interface CheckedRunnable {
    void run() throws Exception;
  }

  private static <T> T unchecked(String message, CheckedSupplier<T> op) {
    try {
      return op.get();
    } catch (RuntimeException e) {
      throw e;
    } catch (Exception e) {
      throw new StorageException(message, e);
    }
  }

  private static void unchecked(String message, CheckedRunnable op) {
    try {
      op.run();
    } catch (RuntimeException e) {
      throw e;
    } catch (Exception e) {
      throw new StorageException(message, e);
    }
  }

  private Path repoPath(String customerId) {
    return reposRoot.resolve(customerId + ".git");
  }

  private Repository openRepo(String customerId) throws IOException {
    return Git.open(repoPath(customerId).toFile()).getRepository();
  }

  // Internal, git-specific naming is fine below this point -- only the
  // interface's own vocabulary needed to stay generic (see class javadoc).

  private static String refName(DocumentRef doc, String versionName) {
    return "refs/heads/docs/" + doc.docId() + "/" + versionName;
  }

  private static String docDir(DocumentRef doc) {
    return doc.docId();
  }

  private static String languageDir(DocumentRef doc, String language) {
    return doc.docId() + "/" + language;
  }

  @Override
  public synchronized void initCustomer(String customerId, CustomerMeta meta) {
    unchecked("failed to init customer " + customerId, () -> {
      Path path = repoPath(customerId);
      if (!Files.exists(path.resolve("HEAD")) && !Files.exists(path.resolve(".git"))) {
        Files.createDirectories(path.getParent());
        Git.init().setDirectory(path.toFile()).setInitialBranch("master").call().close();
      }
      // Always (re-)written, even on a retry against an already-initialized
      // repo -- writing the same content again is harmless (a no-op or a
      // trivial duplicate commit), and a retry after a partial earlier
      // failure is exactly the case where this needs to actually happen.
      try (Repository repo = openRepo(customerId)) {
        ObjectId branchHead = repo.resolve("refs/heads/master");
        try (ObjectInserter inserter = repo.newObjectInserter()) {
          ObjectId blobId = inserter.insert(Constants.OBJ_BLOB, JSON.writeValueAsBytes(meta));
          ObjectId newTreeId = buildTreeWithOverride(repo, inserter, branchHead, Map.of("_customer.meta.json", blobId));
          ObjectId newCommitId = commit(repo, inserter, branchHead, newTreeId, "system", "customer metadata for " + customerId);
          updateBranchRef(repo, "refs/heads/master", branchHead, newCommitId);
        }
      }
    });
  }

  /** refs/heads/docs/<docId>/<versionName> -- same parsing shape RefReconciliationService uses internally. */
  private record RefParts(String docId, String versionName) {
    static RefParts parse(String ref) {
      String prefix = "refs/heads/docs/";
      if (!ref.startsWith(prefix)) return null;
      String[] parts = ref.substring(prefix.length()).split("/", 2);
      if (parts.length != 2) return null;
      return new RefParts(parts[0], parts[1]);
    }
  }

  @Override
  public List<String> listDocuments(String customerId) {
    Set<String> docIds = new LinkedHashSet<>();
    for (String ref : listAllRefs(customerId).keySet()) {
      RefParts parts = RefParts.parse(ref);
      if (parts != null) docIds.add(parts.docId());
    }
    return docIds.stream().sorted().collect(Collectors.toList());
  }

  @Override
  public synchronized String createDocument(DocumentRef doc, DocumentMeta meta) {
    return unchecked("failed to create document " + doc.docId(), () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        String ref = refName(doc, "master");
        ObjectId branchHead = repo.resolve(ref);

        try (ObjectInserter inserter = repo.newObjectInserter()) {
          // No language content yet -- languages get added incrementally
          // via save() as translations land, all within this same version.
          ObjectId blobId = inserter.insert(Constants.OBJ_BLOB, JSON.writeValueAsBytes(meta));
          ObjectId newTreeId = buildTreeWithOverride(repo, inserter, branchHead, Map.of(docDir(doc) + "/meta.json", blobId));
          ObjectId newCommitId = commit(repo, inserter, branchHead, newTreeId, "system", "create document " + doc.docId());
          updateBranchRef(repo, ref, branchHead, newCommitId);
          return newCommitId.getName();
        }
      }
    });
  }

  @Override
  public List<String> listVersions(DocumentRef doc) {
    String prefix = "refs/heads/docs/" + doc.docId() + "/";
    return listAllRefs(doc.customerId()).keySet().stream()
        .filter(ref -> ref.startsWith(prefix))
        .map(ref -> ref.substring(prefix.length()))
        .sorted()
        .collect(Collectors.toList());
  }

  /**
   * NOT part of the DocumentStorageService interface -- see this class's
   * javadoc. Reads _customer.meta.json off master; used by
   * MultiTenantAdminController to show a display name alongside each
   * readable customerId in the admin UI's dropdown.
   */
  public Optional<CustomerMeta> readCustomerMeta(String customerId) {
    return unchecked("failed to read metadata for customer " + customerId, () -> {
      try (Repository repo = openRepo(customerId)) {
        byte[] bytes = readBlob(repo, "refs/heads/master", "_customer.meta.json");
        if (bytes == null) return Optional.empty();
        return Optional.of(JSON.readValue(bytes, CustomerMeta.class));
      }
    });
  }

  /**
   * NOT part of the DocumentStorageService interface -- see this class's
   * javadoc. Its only consumer, GitReconciliationService, recovers a
   * document's title from whichever version it's currently examining when
   * no matching index row exists at all.
   */
  public Optional<DocumentMeta> readDocumentMeta(DocumentRef doc, String versionName) {
    return unchecked("failed to read metadata for " + doc.docId(), () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        byte[] bytes = readBlob(repo, refName(doc, versionName), docDir(doc) + "/meta.json");
        if (bytes == null) return Optional.empty();
        return Optional.of(JSON.readValue(bytes, DocumentMeta.class));
      }
    });
  }

  @Override
  public List<String> listLanguages(DocumentRef doc, String versionName) {
    return unchecked("failed to list languages for " + doc.docId(), () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        ObjectId commitId = repo.resolve(refName(doc, versionName));
        List<String> languages = new ArrayList<>();
        if (commitId == null) return languages;

        try (RevWalk revWalk = new RevWalk(repo)) {
          RevCommit commit = revWalk.parseCommit(commitId);
          try (TreeWalk docWalk = TreeWalk.forPath(repo, docDir(doc), commit.getTree())) {
            if (docWalk == null || !docWalk.isSubtree()) return languages;
            try (TreeWalk childWalk = new TreeWalk(repo)) {
              childWalk.addTree(docWalk.getObjectId(0));
              childWalk.setRecursive(false);
              while (childWalk.next()) {
                if (childWalk.isSubtree()) languages.add(childWalk.getNameString());
              }
            }
          }
        }
        return languages;
      }
    });
  }

  @Override
  public Optional<byte[]> load(DocumentRef doc, String versionName, String language) {
    return unchecked("failed to load " + doc.docId() + "/" + language, () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        // versionName is usually a real named version, but may also be an
        // opaque revision identifier this class previously handed back
        // (see save()/createVersion()/findMergeBase()'s own javadoc) --
        // e.g. collab-server loading content as of the merge-base commit
        // before a 3-way merge, which has no version name of its own.
        ObjectId commitId = repo.resolve(refName(doc, versionName));
        if (commitId == null) {
          commitId = repo.resolve(versionName);
        }
        if (commitId == null) return Optional.empty();
        ObjectId blobId = repo.resolve(commitId.getName() + ":" + languageDir(doc, language) + "/content.ydoc");
        if (blobId == null) return Optional.empty();
        try (ObjectReader reader = repo.newObjectReader()) {
          return Optional.of(reader.open(blobId).getBytes());
        }
      }
    });
  }

  private byte[] readBlob(Repository repo, String ref, String path) throws IOException {
    ObjectId commitId = repo.resolve(ref);
    if (commitId == null) return null;
    ObjectId blobId = repo.resolve(commitId.getName() + ":" + path);
    if (blobId == null) return null;
    try (ObjectReader reader = repo.newObjectReader()) {
      return reader.open(blobId).getBytes();
    }
  }

  @Override
  public String loadChangelog(DocumentRef doc, String versionName, String language) {
    return unchecked("failed to load changelog for " + doc.docId() + "/" + language, () -> {
      byte[] bytes;
      try (Repository repo = openRepo(doc.customerId())) {
        bytes = readBlob(repo, refName(doc, versionName), languageDir(doc, language) + "/changelog.jsonl");
      }
      return bytes == null ? "" : new String(bytes, StandardCharsets.UTF_8);
    });
  }

  @Override
  public synchronized String save(DocumentRef doc, String versionName, String language,
                                   byte[] contentBytes, String markdown, String changelogJson, String author) {
    return unchecked("failed to save " + doc.docId() + "/" + language, () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        String ref = refName(doc, versionName);
        ObjectId branchHead = repo.resolve(ref);
        String dir = languageDir(doc, language);

        try (ObjectInserter inserter = repo.newObjectInserter()) {
          Map<String, ObjectId> overrides = new LinkedHashMap<>();
          overrides.put(dir + "/content.ydoc", inserter.insert(Constants.OBJ_BLOB, contentBytes));
          overrides.put(dir + "/content.md", inserter.insert(Constants.OBJ_BLOB, markdown.getBytes(StandardCharsets.UTF_8)));
          overrides.put(dir + "/changelog.jsonl",
              inserter.insert(Constants.OBJ_BLOB, (changelogJson == null ? "" : changelogJson).getBytes(StandardCharsets.UTF_8)));

          // Every other language already in this version's tree, and the
          // document's own meta.json, are carried forward untouched by
          // buildTreeWithOverride -- this is exactly what lets languages
          // coexist and evolve independently within one version.
          ObjectId newTreeId = buildTreeWithOverride(repo, inserter, branchHead, overrides);
          ObjectId newCommitId = commit(repo, inserter, branchHead, newTreeId, author,
              "snapshot of " + doc.docId() + "/" + language + " by " + author);
          updateBranchRef(repo, ref, branchHead, newCommitId);
          return newCommitId.getName();
        }
      }
    });
  }

  /**
   * Carries forward every path already in branchHead's tree except the
   * ones being overridden -- never touches a working tree/index (see this
   * class's own javadoc for why that's deliberate, not an arbitrary style
   * choice).
   */
  private ObjectId buildTreeWithOverride(Repository repo, ObjectInserter inserter, ObjectId branchHead,
                                          Map<String, ObjectId> overrides) throws IOException {
    DirCache dirCache = DirCache.newInCore();
    DirCacheBuilder builder = dirCache.builder();

    if (branchHead != null) {
      try (RevWalk revWalk = new RevWalk(repo); TreeWalk treeWalk = new TreeWalk(repo)) {
        RevCommit headCommit = revWalk.parseCommit(branchHead);
        treeWalk.addTree(headCommit.getTree());
        treeWalk.setRecursive(true);
        while (treeWalk.next()) {
          String path = treeWalk.getPathString();
          if (overrides.containsKey(path)) continue; // superseded below
          DirCacheEntry entry = new DirCacheEntry(path);
          entry.setObjectId(treeWalk.getObjectId(0));
          entry.setFileMode(treeWalk.getFileMode(0));
          builder.add(entry);
        }
      }
    }

    for (Map.Entry<String, ObjectId> e : overrides.entrySet()) {
      DirCacheEntry entry = new DirCacheEntry(e.getKey());
      entry.setObjectId(e.getValue());
      entry.setFileMode(FileMode.REGULAR_FILE);
      builder.add(entry);
    }

    builder.finish();
    return dirCache.writeTree(inserter);
  }

  private ObjectId commit(Repository repo, ObjectInserter inserter, ObjectId parent, ObjectId treeId,
                           String author, String message) throws IOException {
    PersonIdent identity = new PersonIdent(author, author + "@collab.local");
    CommitBuilder commitBuilder = new CommitBuilder();
    commitBuilder.setTreeId(treeId);
    if (parent != null) {
      commitBuilder.setParentId(parent);
    }
    commitBuilder.setAuthor(identity);
    commitBuilder.setCommitter(identity);
    commitBuilder.setMessage(message);
    ObjectId newCommitId = inserter.insert(commitBuilder);
    inserter.flush();
    return newCommitId;
  }

  private void updateBranchRef(Repository repo, String ref, ObjectId expectedOld, ObjectId newId) throws IOException {
    RefUpdate refUpdate = repo.updateRef(ref);
    refUpdate.setNewObjectId(newId);
    refUpdate.setExpectedOldObjectId(expectedOld == null ? ObjectId.zeroId() : expectedOld);
    RefUpdate.Result result = refUpdate.update();
    if (result != RefUpdate.Result.NEW && result != RefUpdate.Result.FAST_FORWARD && result != RefUpdate.Result.FORCED) {
      throw new IOException("failed to update ref " + ref + ": " + result);
    }
  }

  @Override
  public synchronized String createVersion(DocumentRef doc, String versionName, String fromVersionName) {
    return unchecked("failed to create version " + versionName + " for " + doc.docId(), () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        String sourceRef = refName(doc, fromVersionName);
        String newRef = refName(doc, versionName);
        ObjectId sourceId = repo.resolve(sourceRef);
        if (sourceId == null) {
          throw new IllegalStateException("source version not found: " + sourceRef);
        }
        if (repo.resolve(newRef) != null) {
          throw new IllegalStateException("version already exists: " + newRef);
        }
        updateBranchRef(repo, newRef, null, sourceId);
        return sourceId.getName();
      }
    });
  }

  @Override
  public synchronized void deleteVersion(DocumentRef doc, String versionName) {
    unchecked("failed to delete version " + versionName + " for " + doc.docId(), () -> {
      // "master" holds a document's shipped, all-languages-complete state
      // and every other version's history traces back to it, so deleting
      // it would orphan the whole document, not just remove one line of
      // history.
      if ("master".equals(versionName)) {
        throw new IllegalArgumentException("cannot delete the default version: " + versionName);
      }
      try (Repository repo = openRepo(doc.customerId())) {
        String ref = refName(doc, versionName);
        RefUpdate refUpdate = repo.updateRef(ref);
        refUpdate.setForceUpdate(true);
        RefUpdate.Result result = refUpdate.delete();
        if (result != RefUpdate.Result.FORCED && result != RefUpdate.Result.NO_CHANGE) {
          throw new IOException("failed to delete ref " + ref + ": " + result);
        }
      }
    });
  }

  @Override
  public synchronized MergeOutcome merge(DocumentRef doc, String sourceVersionName, String targetVersionName, String language,
                                          byte[] mergedContentBytes, String mergedMarkdown, String author) {
    return unchecked("failed to merge " + sourceVersionName + " into " + targetVersionName + " for " + doc.docId(), () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        String targetRef = refName(doc, targetVersionName);
        String sourceRef = refName(doc, sourceVersionName);
        ObjectId targetHead = repo.resolve(targetRef);
        ObjectId sourceHead = repo.resolve(sourceRef);
        if (targetHead == null || sourceHead == null) {
          throw new IllegalStateException("both versions must exist: " + targetRef + ", " + sourceRef);
        }

        try (ObjectInserter inserter = repo.newObjectInserter()) {
          String dir = languageDir(doc, language);
          Map<String, ObjectId> overrides = new LinkedHashMap<>();
          overrides.put(dir + "/content.ydoc", inserter.insert(Constants.OBJ_BLOB, mergedContentBytes));
          overrides.put(dir + "/content.md", inserter.insert(Constants.OBJ_BLOB, mergedMarkdown.getBytes(StandardCharsets.UTF_8)));

          ObjectId newTreeId = buildTreeWithOverride(repo, inserter, targetHead, overrides);

          PersonIdent identity = new PersonIdent(author, author + "@collab.local");
          CommitBuilder commitBuilder = new CommitBuilder();
          commitBuilder.setTreeId(newTreeId);
          commitBuilder.setParentIds(targetHead, sourceHead);
          commitBuilder.setAuthor(identity);
          commitBuilder.setCommitter(identity);
          commitBuilder.setMessage("merge " + sourceRef + " into " + targetRef + " by " + author);

          ObjectId newCommitId = inserter.insert(commitBuilder);
          inserter.flush();
          updateBranchRef(repo, targetRef, targetHead, newCommitId);

          RevCommit parsed;
          try (RevWalk revWalk = new RevWalk(repo)) {
            parsed = revWalk.parseCommit(newCommitId);
          }
          return new MergeOutcome(true, "MERGED", newCommitId.getName(), parsed.getParentCount());
        }
      }
    });
  }

  @Override
  public List<BlameLine> history(DocumentRef doc, String versionName, String language) {
    return unchecked("failed to compute history for " + doc.docId() + "/" + language, () -> {
      List<BlameLine> lines = new ArrayList<>();
      try (Repository repo = openRepo(doc.customerId())) {
        ObjectId branchHead = repo.resolve(refName(doc, versionName));
        if (branchHead == null) return lines;

        BlameResult result = new Git(repo).blame()
            .setFilePath(languageDir(doc, language) + "/content.md")
            .setStartCommit(branchHead)
            .call();
        if (result == null) return lines;

        RawText content = result.getResultContents();
        for (int i = 0; i < content.size(); i++) {
          PersonIdent sourceAuthor = result.getSourceAuthor(i);
          RevCommit sourceCommit = result.getSourceCommit(i);

          lines.add(new BlameLine(
              i + 1,
              content.getString(i),
              sourceAuthor != null ? sourceAuthor.getName() : "unknown",
              sourceCommit != null ? sourceCommit.getName() : null,
              sourceCommit != null ? sourceCommit.getAuthorIdent().getWhen().toInstant().toString() : null
          ));
        }
      }
      return lines;
    });
  }

  /**
   * NOT part of the DocumentStorageService interface -- same category as
   * listAllRefs. Scans reposRoot directly for every
   * customer's .git directory -- there's no Postgres customer registry
   * yet (see STATE.md's RFC section), so this is the only way to
   * enumerate customers right now. Fine at admin-tool scale (a directory
   * scan, not a query against thousands of rows); not meant to be the
   * long-term answer once the index actually exists.
   */
  public List<String> listCustomerIds() {
    return unchecked("failed to list customers", () -> {
      List<String> ids = new ArrayList<>();
      if (!Files.isDirectory(reposRoot)) return ids;
      try (DirectoryStream<Path> repos = Files.newDirectoryStream(reposRoot, "*.git")) {
        for (Path repo : repos) {
          String name = repo.getFileName().toString();
          ids.add(name.substring(0, name.length() - ".git".length()));
        }
      }
      return ids;
    });
  }

  /**
   * NOT part of the DocumentStorageService interface -- same category as
   * listCustomerIds. A much bigger blast radius than deleteVersion:
   * removes the customer's entire repo -- every document, every version,
   * every commit -- not one ref. No "still has documents" guard the way
   * deleteVersion protects "master": unlike deleting one version (which
   * would orphan the rest of that document's history while the document
   * still nominally exists), deleting a whole customer takes everything
   * with it atomically by design, so there's nothing left to orphan.
   * MultiTenantAdminController's confirmation dialog is the safety
   * mechanism here, not a technical guard.
   */
  public synchronized void deleteCustomer(String customerId) {
    unchecked("failed to delete customer " + customerId, () -> deleteRecursively(repoPath(customerId)));
  }

  private static void deleteRecursively(Path path) throws IOException {
    if (!Files.exists(path)) return;
    if (Files.isDirectory(path)) {
      try (DirectoryStream<Path> children = Files.newDirectoryStream(path)) {
        for (Path child : children) {
          deleteRecursively(child);
        }
      }
    }
    Files.delete(path);
  }

  /**
   * NOT part of the DocumentStorageService interface -- see this class's
   * javadoc. Every ref under refs/heads/ to its tip commit SHA, for
   * GitReconciliationService and MultiTenantAdminController.
   */
  public Map<String, String> listAllRefs(String customerId) {
    return unchecked("failed to list refs for customer " + customerId, () -> {
      try (Repository repo = openRepo(customerId)) {
        Map<String, String> refs = new LinkedHashMap<>();
        for (Ref ref : repo.getRefDatabase().getRefsByPrefix("refs/heads/")) {
          ObjectId id = ref.getObjectId();
          if (id != null) {
            refs.put(ref.getName(), id.getName());
          }
        }
        return refs;
      }
    });
  }

  @Override
  public String findMergeBase(DocumentRef doc, String versionA, String versionB) {
    return unchecked("failed to find merge base for " + doc.docId(), () -> {
      try (Repository repo = openRepo(doc.customerId()); RevWalk revWalk = new RevWalk(repo)) {
        ObjectId aId = repo.resolve(refName(doc, versionA));
        ObjectId bId = repo.resolve(refName(doc, versionB));
        if (aId == null || bId == null) {
          throw new IllegalStateException("both versions must exist: " + versionA + ", " + versionB);
        }
        revWalk.setRevFilter(RevFilter.MERGE_BASE);
        revWalk.markStart(revWalk.parseCommit(aId));
        revWalk.markStart(revWalk.parseCommit(bId));
        RevCommit mergeBase = revWalk.next();
        return mergeBase == null ? null : mergeBase.getName();
      }
    });
  }
}
