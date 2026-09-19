import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.api.MergeResult;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.lib.Ref;
import org.eclipse.jgit.merge.MergeStrategy;
import org.eclipse.jgit.revwalk.RevCommit;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public class Main {
  public static void main(String[] args) throws Exception {
    Path repoDir = Files.createTempDirectory("jgit-merge-test");
    System.out.println("repo at: " + repoDir);

    Git git = Git.init().setDirectory(repoDir.toFile()).setInitialBranch("main").call();
    Path docFile = repoDir.resolve("doc.txt");

    PersonIdent base = new PersonIdent("Base-User", "base@test");
    Files.writeString(docFile, "base content\n", StandardCharsets.UTF_8);
    git.add().addFilepattern("doc.txt").call();
    RevCommit baseCommit = git.commit().setAuthor(base).setCommitter(base).setMessage("base").call();
    System.out.println("base commit: " + baseCommit.getName());

    git.branchCreate().setName("branchA").call();
    git.branchCreate().setName("branchB").call();

    git.checkout().setName("branchA").call();
    PersonIdent userA = new PersonIdent("User-A", "usera@test");
    Files.writeString(docFile, "content edited on branch A\n", StandardCharsets.UTF_8);
    git.add().addFilepattern("doc.txt").call();
    RevCommit commitA = git.commit().setAuthor(userA).setCommitter(userA).setMessage("edit on A").call();
    System.out.println("branchA tip: " + commitA.getName());

    git.checkout().setName("branchB").call();
    PersonIdent userB = new PersonIdent("User-B", "userb@test");
    Files.writeString(docFile, "content edited on branch B\n", StandardCharsets.UTF_8);
    git.add().addFilepattern("doc.txt").call();
    RevCommit commitB = git.commit().setAuthor(userB).setCommitter(userB).setMessage("edit on B").call();
    System.out.println("branchB tip: " + commitB.getName());

    // Go back to branchA, and "merge" branchB into it using the OURS strategy,
    // which produces a real two-parent commit but keeps branchA's tree untouched.
    git.checkout().setName("branchA").call();
    Ref branchBRef = git.getRepository().findRef("branchB");

    MergeResult mergeResult = git.merge()
        .include(branchBRef)
        .setStrategy(MergeStrategy.OURS)
        .setCommit(true)
        .setMessage("merge branchB into branchA (ours, pre-amend)")
        .call();

    System.out.println("merge status: " + mergeResult.getMergeStatus());

    RevCommit mergeCommit;
    try (var revWalk = new org.eclipse.jgit.revwalk.RevWalk(git.getRepository())) {
      mergeCommit = revWalk.parseCommit(git.getRepository().resolve("branchA"));
      revWalk.parseHeaders(mergeCommit);
      System.out.println("merge commit: " + mergeCommit.getName());
      System.out.println("parent count: " + mergeCommit.getParentCount());
      for (RevCommit parent : mergeCommit.getParents()) {
        System.out.println("  parent: " + parent.getName());
      }
    }

    System.out.println("expected parentA=" + commitA.getName() + " parentB=" + commitB.getName());
    System.out.println("doc.txt content after ours-merge: " + Files.readString(docFile).trim());

    // Now overwrite with the "real" app-level (Yjs CRDT) merged content and amend.
    Files.writeString(docFile, "ACTUAL MERGED CONTENT FROM YJS CRDT MERGE\n", StandardCharsets.UTF_8);
    git.add().addFilepattern("doc.txt").call();

    PersonIdent mergeIdent = new PersonIdent("merge-bot", "merge-bot@test");
    RevCommit amended = git.commit()
        .setAmend(true)
        .setAuthor(mergeIdent)
        .setCommitter(mergeIdent)
        .setMessage("merge branchB into branchA (yjs CRDT-resolved content)")
        .call();

    System.out.println("=== AFTER AMEND ===");
    System.out.println("amended commit: " + amended.getName());
    System.out.println("amended parent count: " + amended.getParentCount());
    for (RevCommit parent : amended.getParents()) {
      System.out.println("  parent: " + parent.getName());
    }
    System.out.println("doc.txt content after amend: " + Files.readString(docFile).trim());

    boolean parentsPreserved = amended.getParentCount() == 2
        && amended.getParent(0).getName().equals(commitA.getName())
        && amended.getParent(1).getName().equals(commitB.getName());
    System.out.println("PARENTS_PRESERVED_CORRECTLY=" + parentsPreserved);

    git.close();
  }
}
