-- Transactions already own capability grants. Announce changes after commit so
-- an open 4.0 page can drop its native catalog cache. Payloads contain no data
-- used to grant access. Readers resolve the exact current binding again.
create trigger allrice_d_entry_personal_skill_binding_changed
  after insert or update or delete on allrice_personal_skill_bindings
  for each row execute function allrice_d_entry_authority_changed();

create trigger allrice_d_entry_personal_skill_installation_changed
  after update of current_version_id, state or delete on allrice_personal_skill_installations
  for each row execute function allrice_d_entry_authority_changed();

create trigger allrice_d_entry_employee_skill_binding_changed
  after insert or update or delete on allrice_employee_dsh_skill_bindings
  for each row execute function allrice_d_entry_authority_changed();

create trigger allrice_d_entry_skill_source_changed
  after update or delete on allrice_dsh_skills
  for each row execute function allrice_d_entry_authority_changed();
