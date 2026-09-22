package com.diy.blueprints.collabeditor.persistence.index.repository;

import com.diy.blueprints.collabeditor.persistence.index.entity.Customer;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;
import java.util.UUID;

public interface CustomerRepository extends JpaRepository<Customer, UUID> {
  Optional<Customer> findBySlug(String slug);
}
