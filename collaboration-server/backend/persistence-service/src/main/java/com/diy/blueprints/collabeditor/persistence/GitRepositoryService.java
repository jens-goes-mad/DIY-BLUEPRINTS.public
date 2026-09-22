package com.diy.blueprints.collabeditor.persistence;

import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.blame.BlameResult;
import org.eclipse.jgit.dircache.DirCache;
import org.eclipse.jgit.dircache.DirCacheBuilder;
import org.eclipse.jgit.dircache.DirCacheEntry;
import org.eclipse.jgit.diff.RawText;
import org.eclipse.jgit.lib.*;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.revwalk.filter.RevFilter;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Git is used purely as a persistence/audit layer here: an immutable commit
 * log of snapshots per branch. It is never asked to content-merge anything —
 * ordinary save/load never touch the working tree at all (pure object-database
 * plumbing, so concurrent branches never race over a checkout). The one
 * exception is merge(): a resolved Yjs CRDT merge is computed elsewhere and
 * handed in already-finished; git's only job is to record a commit whose two
 * parents are the branches that were combined.
 */
@Service
public class GitRepositoryService {

  private static final String DEFAULT_BRANCH = "master";

  private final Path repoRoot;

  public GitRepositoryService(@Value("${repo.path:/data/repo}") String repoPath) {
    this.repoRoot = Path.of(repoPath);
  }

  @PostConstruct
  void init() throws Exception {
    Files.createDirectories(repoRoot);
    if (!Files.exists(repoRoot.resolve(".git"))) {
      Git.init().setDirectory(repoRoot.toFile()).setInitialBranch(DEFAULT_BRANCH).call().close();
    }
  }

  private Repository openRepo() throws IOException {
    return Git.open(repoRoot.toFile()).getRepository();
  }

  public byte[] loadSnapshot(String docId, String branch) throws IOException {
    try (Repository repo = openRepo()) {
      return readBlob(repo, branch, docId + ".ydoc");
    }
  }

  public String loadMarkdown(String docId, String branch) throws IOException {
    byte[] bytes;
    try (Repository repo = openRepo()) {
      bytes = readBlob(repo, branch, docId + ".md");
    }
    return bytes == null ? "" : new String(bytes, StandardCharsets.UTF_8);
  }

  /**
   * The changelog committed alongside a snapshot holds only the individual
   * per-save chunks since the *previous* commit on this branch (see
   * DocumentController) -- not the whole history. To see further back,
   * walk the branch's commit log and read each commit's own changelog blob.
   */
  public String loadChangelog(String docId, String branch) throws IOException {
    byte[] bytes;
    try (Repository repo = openRepo()) {
      bytes = readBlob(repo, branch, docId + ".changelog.jsonl");
    }
    return bytes == null ? "" : new String(bytes, StandardCharsets.UTF_8);
  }

  private byte[] readBlob(Repository repo, String branch, String path) throws IOException {
    ObjectId blobId = repo.resolve(branch + ":" + path);
    if (blobId == null) {
      return null;
    }
    try (ObjectReader reader = repo.newObjectReader()) {
      return reader.open(blobId).getBytes();
    }
  }

  /**
   * Writes a new commit for the given branch, never touching the working tree.
   * Any other files already present on the branch's tree are carried forward untouched.
   */
  public synchronized String save(String docId, String branch, byte[] ydocBytes, String markdown,
                                   String changelog, String author) throws IOException {
    try (Repository repo = openRepo()) {
      ObjectId branchHead = repo.resolve(branch);

      try (ObjectInserter inserter = repo.newObjectInserter()) {
        ObjectId newTreeId = buildTree(repo, inserter, branchHead, docId, ydocBytes, markdown, changelog);

        PersonIdent identity = new PersonIdent(author, author + "@collab.local");
        CommitBuilder commitBuilder = new CommitBuilder();
        commitBuilder.setTreeId(newTreeId);
        if (branchHead != null) {
          commitBuilder.setParentId(branchHead);
        }
        commitBuilder.setAuthor(identity);
        commitBuilder.setCommitter(identity);
        commitBuilder.setMessage("snapshot of " + docId + " by " + author);

        ObjectId newCommitId = inserter.insert(commitBuilder);
        inserter.flush();

        updateBranchRef(repo, branch, branchHead, newCommitId);
        return newCommitId.getName();
      }
    }
  }

  private ObjectId buildTree(Repository repo, ObjectInserter inserter, ObjectId branchHead,
                              String docId, byte[] ydocBytes, String markdown, String changelog) throws IOException {
    ObjectId ydocBlobId = inserter.insert(Constants.OBJ_BLOB, ydocBytes);
    ObjectId mdBlobId = inserter.insert(Constants.OBJ_BLOB, markdown.getBytes(StandardCharsets.UTF_8));
    ObjectId changelogBlobId = inserter.insert(Constants.OBJ_BLOB,
        (changelog == null ? "" : changelog).getBytes(StandardCharsets.UTF_8));

    String ydocPath = docId + ".ydoc";
    String mdPath = docId + ".md";
    String changelogPath = docId + ".changelog.jsonl";

    DirCache dirCache = DirCache.newInCore();
    DirCacheBuilder builder = dirCache.builder();

    if (branchHead != null) {
      try (RevWalk revWalk = new RevWalk(repo); TreeWalk treeWalk = new TreeWalk(repo)) {
        RevCommit headCommit = revWalk.parseCommit(branchHead);
        treeWalk.addTree(headCommit.getTree());
        treeWalk.setRecursive(true);
        while (treeWalk.next()) {
          String path = treeWalk.getPathString();
          if (path.equals(ydocPath) || path.equals(mdPath) || path.equals(changelogPath)) {
            continue; // superseded by the new blobs below
          }
          DirCacheEntry entry = new DirCacheEntry(path);
          entry.setObjectId(treeWalk.getObjectId(0));
          entry.setFileMode(treeWalk.getFileMode(0));
          builder.add(entry);
        }
      }
    }

    DirCacheEntry ydocEntry = new DirCacheEntry(ydocPath);
    ydocEntry.setObjectId(ydocBlobId);
    ydocEntry.setFileMode(FileMode.REGULAR_FILE);
    builder.add(ydocEntry);

    DirCacheEntry mdEntry = new DirCacheEntry(mdPath);
    mdEntry.setObjectId(mdBlobId);
    mdEntry.setFileMode(FileMode.REGULAR_FILE);
    builder.add(mdEntry);

    DirCacheEntry changelogEntry = new DirCacheEntry(changelogPath);
    changelogEntry.setObjectId(changelogBlobId);
    changelogEntry.setFileMode(FileMode.REGULAR_FILE);
    builder.add(changelogEntry);

    builder.finish();
    return dirCache.writeTree(inserter);
  }

  private void updateBranchRef(Repository repo, String branch, ObjectId expectedOld, ObjectId newId) throws IOException {
    RefUpdate refUpdate = repo.updateRef("refs/heads/" + branch);
    refUpdate.setNewObjectId(newId);
    refUpdate.setExpectedOldObjectId(expectedOld == null ? ObjectId.zeroId() : expectedOld);
    RefUpdate.Result result = refUpdate.update();
    if (result != RefUpdate.Result.NEW && result != RefUpdate.Result.FAST_FORWARD && result != RefUpdate.Result.FORCED) {
      throw new IOException("failed to update ref refs/heads/" + branch + ": " + result);
    }
  }

  public synchronized void createBranch(String newBranch, String fromBranch) throws IOException {
    try (Repository repo = openRepo()) {
      ObjectId sourceId = repo.resolve(fromBranch);
      if (sourceId == null) {
        throw new IllegalStateException("source branch not found: " + fromBranch);
      }
      if (repo.resolve(newBranch) != null) {
        throw new IllegalStateException("branch already exists: " + newBranch);
      }
      updateBranchRef(repo, newBranch, null, sourceId);
    }
  }

  /**
   * The default branch is never deletable -- every docId's content lives
   * there, and every other branch's history traces back to it, so
   * deleting it would orphan the whole repo, not just remove one line of
   * history.
   */
  public synchronized void deleteBranch(String branch) throws IOException {
    if (DEFAULT_BRANCH.equals(branch)) {
      throw new IllegalArgumentException("cannot delete the default branch: " + branch);
    }
    try (Repository repo = openRepo()) {
      RefUpdate refUpdate = repo.updateRef("refs/heads/" + branch);
      refUpdate.setForceUpdate(true);
      RefUpdate.Result result = refUpdate.delete();
      if (result != RefUpdate.Result.FORCED && result != RefUpdate.Result.NO_CHANGE) {
        throw new IOException("failed to delete branch " + branch + ": " + result);
      }
    }
  }

  /**
   * The commit both branches diverged from -- needed by collab-server to
   * detect conflicts before merging (it decodes what each branch actually
   * changed relative to this shared ancestor). Returns null if the
   * branches share no history at all.
   */
  public String findMergeBase(String branchA, String branchB) throws IOException {
    try (Repository repo = openRepo(); RevWalk revWalk = new RevWalk(repo)) {
      ObjectId aId = repo.resolve(branchA);
      ObjectId bId = repo.resolve(branchB);
      if (aId == null || bId == null) {
        throw new IllegalStateException("both branches must exist: " + branchA + ", " + branchB);
      }
      revWalk.setRevFilter(RevFilter.MERGE_BASE);
      revWalk.markStart(revWalk.parseCommit(aId));
      revWalk.markStart(revWalk.parseCommit(bId));
      RevCommit mergeBase = revWalk.next();
      return mergeBase == null ? null : mergeBase.getName();
    }
  }

  public List<String> listBranches() throws IOException {
    try (Repository repo = openRepo()) {
      List<String> names = new ArrayList<>();
      for (Ref ref : repo.getRefDatabase().getRefsByPrefix("refs/heads/")) {
        names.add(ref.getName().substring("refs/heads/".length()));
      }
      return names;
    }
  }

  /**
   * Records that mergedYdoc/mergedMarkdown (already produced by a Yjs CRDT merge
   * elsewhere) is the new state of targetBranch, resulting from combining it with
   * sourceBranch. Pure object-database plumbing, same approach as save() and for
   * the same reason -- see the incident this replaced in STATE.md: the original
   * implementation used JGit's MergeCommand + checkout + working-tree add/amend,
   * which silently DROPPED unrelated files from the resulting commit's tree.
   * save() never updates the working tree or index (by design, for concurrency),
   * so JGit's index is permanently stale after any save() call; a later
   * checkout-based commit builds its tree from that stale index rather than the
   * branch's actual HEAD tree, losing anything the index didn't know about. Never
   * touching the working tree at all avoids the whole class of bug.
   */
  public synchronized MergeOutcome merge(String docId, String targetBranch, String sourceBranch,
                                          byte[] mergedYdoc, String mergedMarkdown, String author) throws IOException {
    try (Repository repo = openRepo()) {
      ObjectId targetHead = repo.resolve(targetBranch);
      ObjectId sourceHead = repo.resolve(sourceBranch);
      if (targetHead == null || sourceHead == null) {
        throw new IllegalStateException("both branches must exist: " + targetBranch + ", " + sourceBranch);
      }

      try (ObjectInserter inserter = repo.newObjectInserter()) {
        ObjectId newTreeId = buildTree(repo, inserter, targetHead, docId, mergedYdoc, mergedMarkdown, null);

        PersonIdent identity = new PersonIdent(author, author + "@collab.local");
        CommitBuilder commitBuilder = new CommitBuilder();
        commitBuilder.setTreeId(newTreeId);
        commitBuilder.setParentIds(targetHead, sourceHead);
        commitBuilder.setAuthor(identity);
        commitBuilder.setCommitter(identity);
        commitBuilder.setMessage("merge " + sourceBranch + " into " + targetBranch + " by " + author);

        ObjectId newCommitId = inserter.insert(commitBuilder);
        inserter.flush();

        updateBranchRef(repo, targetBranch, targetHead, newCommitId);

        RevCommit parsed;
        try (RevWalk revWalk = new RevWalk(repo)) {
          parsed = revWalk.parseCommit(newCommitId);
        }
        return new MergeOutcome(true, "MERGED", newCommitId.getName(), parsed.getParentCount());
      }
    }
  }

  public List<BlameLine> history(String docId, String branch) throws Exception {
    List<BlameLine> lines = new ArrayList<>();

    try (Repository repo = openRepo()) {
      ObjectId branchHead = repo.resolve(branch);
      if (branchHead == null) {
        return lines;
      }

      BlameResult result = new org.eclipse.jgit.api.Git(repo).blame()
          .setFilePath(docId + ".md")
          .setStartCommit(branchHead)
          .call();
      if (result == null) {
        return lines;
      }

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
  }
}
