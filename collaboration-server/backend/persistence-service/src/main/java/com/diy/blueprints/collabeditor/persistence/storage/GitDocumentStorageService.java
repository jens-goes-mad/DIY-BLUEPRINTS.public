package com.diy.blueprints.collabeditor.persistence.storage;

import com.diy.blueprints.collabeditor.persistence.MergeOutcome;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.eclipse.jgit.api.Git;
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * The one real implementation of DocumentStorageService: one bare-in-spirit
 * git repo per customer (RFC: multi-tenant scale, STATE.md), sharded on
 * disk to avoid one flat directory at scale:
 * <reposRoot>/<customerId[0:2]>/<customerId>.git. Same pure
 * object-database-plumbing approach as the existing single-repo
 * GitRepositoryService (never touches a working tree -- see that class's
 * javadoc for the 2026-09-19 incident this pattern avoids), generalized to
 * (DocumentRef, versionName) instead of a single fixed repo and (docId, branch).
 *
 * This is also where every git-specific detail behind the interface's
 * generic contract actually lives, kept out of DocumentStorageService's
 * own javadoc on purpose: no JGit type may appear in that interface, so a
 * fake in-memory implementation can back unit tests for merge/conflict
 * logic without a real git repo on disk, and callers never need to know
 * or care that git is the implementation underneath. Concretely:
 * initCustomer() is a git init plus a commit recording CustomerMeta;
 * createDocument() is one commit seeding an empty initial version plus
 * DocumentMeta, in the same tree -- both fold what used to be two
 * separately-callable primitives (init/createVersion and a standalone meta
 * write) into one, since a caller never legitimately wants one without
 * the other, and exposing them separately only invited leaking *how* git
 * durably records identity (a file every branch inherits via ordinary
 * ancestry) as if that were itself a generic operation. readDocumentMeta()
 * and listAllRefs(), below, are deliberately NOT part of
 * DocumentStorageService at all -- same as findMergeBase -- since they're
 * inherently git-specific and their only consumer, GitReconciliationService,
 * is itself explicitly typed to this concrete class rather than the
 * generic interface (see that class's javadoc).
 *
 * Every public method here funnels its body through unchecked() below,
 * which turns whatever checked exception JGit/Jackson/java.io actually
 * throws into a StorageException -- matches DocumentStorageService's own
 * javadoc on why the interface declares no checked exception. A
 * RuntimeException already thrown deliberately inside a method body (e.g.
 * "branch already exists") passes through unwrapped; only genuine checked
 * failures get wrapped.
 *
 * Deliberately a completely separate bean from GitRepositoryService: this
 * class does not replace it, and DocumentController still talks to
 * GitRepositoryService/the single "repo.path" repo entirely unchanged.
 * This is new, additive code -- see STATE.md's RFC section for why it's
 * not yet wired into the live request path.
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
    String shard = customerId.length() >= 2 ? customerId.substring(0, 2) : customerId;
    return reposRoot.resolve(shard).resolve(customerId + ".git");
  }

  private Repository openRepo(String customerId) throws IOException {
    return Git.open(repoPath(customerId).toFile()).getRepository();
  }

  // Internal, git-specific naming is fine below this point -- only the
  // interface's own vocabulary needed to stay generic (see class javadoc).

  private static String refName(DocumentRef doc, String branchName) {
    return "refs/heads/docs/" + doc.docId() + "/" + doc.language() + "/" + branchName;
  }

  private static String docDir(DocumentRef doc) {
    return doc.docId() + "/" + doc.language();
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

  @Override
  public synchronized String createDocument(DocumentRef doc, DocumentMeta meta) {
    return unchecked("failed to create document " + doc.docId() + "/" + doc.language(), () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        String ref = refName(doc, "master");
        ObjectId branchHead = repo.resolve(ref);
        String dir = docDir(doc);

        try (ObjectInserter inserter = repo.newObjectInserter()) {
          Map<String, ObjectId> overrides = new LinkedHashMap<>();
          overrides.put(dir + "/meta.json", inserter.insert(Constants.OBJ_BLOB, JSON.writeValueAsBytes(meta)));
          overrides.put(dir + "/content.ydoc", inserter.insert(Constants.OBJ_BLOB, new byte[0]));
          overrides.put(dir + "/content.md", inserter.insert(Constants.OBJ_BLOB, new byte[0]));
          overrides.put(dir + "/changelog.jsonl", inserter.insert(Constants.OBJ_BLOB, new byte[0]));

          ObjectId newTreeId = buildTreeWithOverride(repo, inserter, branchHead, overrides);
          ObjectId newCommitId = commit(repo, inserter, branchHead, newTreeId, "system",
              "create document " + doc.docId() + "/" + doc.language());
          updateBranchRef(repo, ref, branchHead, newCommitId);
          return newCommitId.getName();
        }
      }
    });
  }

  /**
   * NOT part of the DocumentStorageService interface -- see this class's
   * javadoc. Its only consumer, GitReconciliationService, recovers a
   * document's title from whichever branch it's currently examining when
   * no matching index row exists at all.
   */
  public Optional<DocumentMeta> readDocumentMeta(DocumentRef doc, String versionName) {
    return unchecked("failed to read metadata for " + doc.docId() + "/" + doc.language(), () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        byte[] bytes = readBlob(repo, refName(doc, versionName), docDir(doc) + "/meta.json");
        if (bytes == null) return Optional.empty();
        return Optional.of(JSON.readValue(bytes, DocumentMeta.class));
      }
    });
  }

  @Override
  public Optional<byte[]> load(DocumentRef doc, String versionName) {
    return unchecked("failed to load " + doc.docId() + "/" + doc.language(), () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        byte[] bytes = readBlob(repo, refName(doc, versionName), docDir(doc) + "/content.ydoc");
        return Optional.ofNullable(bytes);
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
  public synchronized String save(DocumentRef doc, String versionName,
                                   byte[] contentBytes, String markdown, String changelogJson, String author) {
    return unchecked("failed to save " + doc.docId() + "/" + doc.language(), () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        String ref = refName(doc, versionName);
        ObjectId branchHead = repo.resolve(ref);
        String dir = docDir(doc);

        try (ObjectInserter inserter = repo.newObjectInserter()) {
          Map<String, ObjectId> overrides = new LinkedHashMap<>();
          overrides.put(dir + "/content.ydoc", inserter.insert(Constants.OBJ_BLOB, contentBytes));
          overrides.put(dir + "/content.md", inserter.insert(Constants.OBJ_BLOB, markdown.getBytes(StandardCharsets.UTF_8)));
          overrides.put(dir + "/changelog.jsonl",
              inserter.insert(Constants.OBJ_BLOB, (changelogJson == null ? "" : changelogJson).getBytes(StandardCharsets.UTF_8)));

          ObjectId newTreeId = buildTreeWithOverride(repo, inserter, branchHead, overrides);
          ObjectId newCommitId = commit(repo, inserter, branchHead, newTreeId, author,
              "snapshot of " + doc.docId() + "/" + doc.language() + " by " + author);
          updateBranchRef(repo, ref, branchHead, newCommitId);
          return newCommitId.getName();
        }
      }
    });
  }

  /**
   * Carries forward every path already in branchHead's tree except the
   * ones being overridden, same approach as the single-repo
   * GitRepositoryService.buildTree -- see that class's javadoc for why
   * this (never touching a working tree/index) is deliberate, not an
   * arbitrary style choice.
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
    return unchecked("failed to create branch " + versionName + " for " + doc.docId() + "/" + doc.language(), () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        String sourceRef = refName(doc, fromVersionName);
        String newRef = refName(doc, versionName);
        ObjectId sourceId = repo.resolve(sourceRef);
        if (sourceId == null) {
          throw new IllegalStateException("source branch not found: " + sourceRef);
        }
        if (repo.resolve(newRef) != null) {
          throw new IllegalStateException("branch already exists: " + newRef);
        }
        updateBranchRef(repo, newRef, null, sourceId);
        return sourceId.getName();
      }
    });
  }

  @Override
  public synchronized void deleteVersion(DocumentRef doc, String versionName) {
    unchecked("failed to delete branch " + versionName + " for " + doc.docId() + "/" + doc.language(), () -> {
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
  public synchronized MergeOutcome merge(DocumentRef doc, String sourceVersionName, String targetVersionName,
                                          byte[] mergedContentBytes, String mergedMarkdown, String author) {
    return unchecked("failed to merge " + sourceVersionName + " into " + targetVersionName
        + " for " + doc.docId() + "/" + doc.language(), () -> {
      try (Repository repo = openRepo(doc.customerId())) {
        String targetRef = refName(doc, targetVersionName);
        String sourceRef = refName(doc, sourceVersionName);
        ObjectId targetHead = repo.resolve(targetRef);
        ObjectId sourceHead = repo.resolve(sourceRef);
        if (targetHead == null || sourceHead == null) {
          throw new IllegalStateException("both branches must exist: " + targetRef + ", " + sourceRef);
        }

        try (ObjectInserter inserter = repo.newObjectInserter()) {
          String dir = docDir(doc);
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

  /**
   * NOT part of the DocumentStorageService interface -- see this class's
   * javadoc. Every ref under refs/heads/ to its tip commit SHA, for
   * GitReconciliationService, the only caller.
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

  /**
   * findMergeBase isn't part of DocumentStorageService's interface (it's a
   * pre-merge lookup collab-server needs, not a storage primitive every
   * caller needs) but every current implementation of that lookup
   * (GitRepositoryService.findMergeBase) is identical in shape -- kept
   * here too for symmetry/reuse once this class is actually wired in.
   */
  public String findMergeBase(DocumentRef doc, String versionA, String versionB) {
    return unchecked("failed to find merge base for " + doc.docId() + "/" + doc.language(), () -> {
      try (Repository repo = openRepo(doc.customerId()); RevWalk revWalk = new RevWalk(repo)) {
        ObjectId aId = repo.resolve(refName(doc, versionA));
        ObjectId bId = repo.resolve(refName(doc, versionB));
        if (aId == null || bId == null) {
          throw new IllegalStateException("both branches must exist: " + versionA + ", " + versionB);
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
