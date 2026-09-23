package com.diy.blueprints.collabeditor.persistence.index.repository;

import com.diy.blueprints.collabeditor.persistence.index.entity.Customer;
import org.springframework.data.jpa.repository.JpaRepository;

public interface CustomerRepository extends JpaRepository<Customer, String> {
}
