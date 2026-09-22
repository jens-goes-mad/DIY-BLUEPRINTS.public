package com.diy.blueprints.collabeditor.persistence.index.repository;

import com.diy.blueprints.collabeditor.persistence.index.entity.Document;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface DocumentRepository extends JpaRepository<Document, UUID> {
  List<Document> findByCustomerId(UUID customerId);
  List<Document> findByCustomerIdAndLanguage(UUID customerId, String language);
  Optional<Document> findByCustomerIdAndDocIdAndLanguage(UUID customerId, String docId, String language);
}
