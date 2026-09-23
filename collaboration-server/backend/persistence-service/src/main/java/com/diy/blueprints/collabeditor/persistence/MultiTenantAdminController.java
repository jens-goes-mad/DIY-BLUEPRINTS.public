package com.diy.blueprints.collabeditor.persistence;

import com.diy.blueprints.collabeditor.persistence.storage.CustomerMeta;
import com.diy.blueprints.collabeditor.persistence.storage.git.GitDocumentStorageService;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.stream.Collectors;

/**
 * Platform/ops only: customer lifecycle (list/create/delete a customer).
 * Deliberately the ONLY thing left here -- everything else that used to
 * live on this controller (documents, versions, languages, content,
 * history) moved to DocumentController once it became customerId-aware,
 * since those are things a regular authenticated user's JWT legitimately
 * scopes them to within their own tenant, whereas enumerating or deleting
 * *which tenants exist at all* never is. Bound to the concrete
 * GitDocumentStorageService rather than the generic interface because
 * readCustomerMeta/listCustomerIds/deleteCustomer are all deliberately
 * NOT part of DocumentStorageService (see that class's javadoc).
 */
@RestController
@RequestMapping("/api/mt")
public class MultiTenantAdminController {

  private final GitDocumentStorageService storage;

  public MultiTenantAdminController(GitDocumentStorageService storage) {
    this.storage = storage;
  }

  public record CustomerSummary(String customerId, String displayName) {}

  @GetMapping("/customers")
  public List<CustomerSummary> listCustomers() {
    return storage.listCustomerIds().stream()
        .map(id -> new CustomerSummary(id, storage.readCustomerMeta(id).map(CustomerMeta::displayName).orElse(id)))
        .collect(Collectors.toList());
  }

  public record CreateCustomerRequest(String customerId, String displayName) {}

  @PostMapping("/customers")
  public void createCustomer(@RequestBody CreateCustomerRequest request) {
    storage.initCustomer(request.customerId(), new CustomerMeta(request.customerId(), request.displayName()));
  }

  @DeleteMapping("/customers/{customerId}")
  public void deleteCustomer(@PathVariable String customerId) {
    storage.deleteCustomer(customerId);
  }
}
