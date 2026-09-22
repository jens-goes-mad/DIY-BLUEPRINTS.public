package com.diy.blueprints.collabeditor.persistence.index.repository;

import com.diy.blueprints.collabeditor.persistence.index.entity.OutboxEvent;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface OutboxRepository extends JpaRepository<OutboxEvent, Long> {
  List<OutboxEvent> findByProcessedAtIsNullOrderByIdAsc();
}
