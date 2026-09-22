package com.diy.blueprints.collabeditor.persistence.index.repository;

import com.diy.blueprints.collabeditor.persistence.index.entity.Branch;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface BranchRepository extends JpaRepository<Branch, UUID> {
  List<Branch> findByDocumentId(UUID documentId);
  Optional<Branch> findByDocumentIdAndVersionName(UUID documentId, String versionName);
  Optional<Branch> findByGitRef(String gitRef);
}
