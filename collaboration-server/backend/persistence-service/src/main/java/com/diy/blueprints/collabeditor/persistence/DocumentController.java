package com.diy.blueprints.collabeditor.persistence;

import org.springframework.web.bind.annotation.*;

import java.util.Base64;
import java.util.List;

@RestController
public class DocumentController {

  private static final String DEFAULT_BRANCH = "master";

  private final GitRepositoryService gitRepositoryService;

  public DocumentController(GitRepositoryService gitRepositoryService) {
    this.gitRepositoryService = gitRepositoryService;
  }

  public record DocumentResponse(String docId, String branch, String ydoc, String markdown) {}

  public record SaveRequest(String ydoc, String markdown, String author) {}

  public record CreateBranchRequest(String newBranch, String fromBranch) {}

  public record MergeRequest(String sourceBranch, String targetBranch, String ydoc, String markdown, String author) {}

  @GetMapping("/api/documents/{docId}")
  public DocumentResponse load(@PathVariable String docId,
                                @RequestParam(defaultValue = DEFAULT_BRANCH) String branch) throws Exception {
    byte[] ydocBytes = gitRepositoryService.loadSnapshot(docId, branch);
    String markdown = gitRepositoryService.loadMarkdown(docId, branch);
    String ydocBase64 = ydocBytes == null ? null : Base64.getEncoder().encodeToString(ydocBytes);
    return new DocumentResponse(docId, branch, ydocBase64, markdown);
  }

  @PostMapping("/api/documents/{docId}")
  public void save(@PathVariable String docId,
                    @RequestParam(defaultValue = DEFAULT_BRANCH) String branch,
                    @RequestBody SaveRequest request) throws Exception {
    byte[] ydocBytes = Base64.getDecoder().decode(request.ydoc());
    gitRepositoryService.save(docId, branch, ydocBytes, request.markdown(), request.author());
  }

  @GetMapping("/api/documents/{docId}/history")
  public List<BlameLine> history(@PathVariable String docId,
                                  @RequestParam(defaultValue = DEFAULT_BRANCH) String branch) throws Exception {
    return gitRepositoryService.history(docId, branch);
  }

  @GetMapping("/api/branches")
  public List<String> listBranches() throws Exception {
    return gitRepositoryService.listBranches();
  }

  @PostMapping("/api/branches")
  public void createBranch(@RequestBody CreateBranchRequest request) throws Exception {
    gitRepositoryService.createBranch(request.newBranch(), request.fromBranch());
  }

  @PostMapping("/api/documents/{docId}/merge")
  public MergeOutcome merge(@PathVariable String docId, @RequestBody MergeRequest request) throws Exception {
    byte[] ydocBytes = Base64.getDecoder().decode(request.ydoc());
    return gitRepositoryService.merge(
        docId, request.targetBranch(), request.sourceBranch(), ydocBytes, request.markdown(), request.author());
  }
}
