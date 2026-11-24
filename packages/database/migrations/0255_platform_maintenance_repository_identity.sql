-- The 4.0 repository has its own empty Dev database and repository authority.
-- Validate the replacement on existing rows so old-repository data fails closed.
alter table allrice_platform_maintenance_defects
  drop constraint allrice_platform_maintenance_defects_repository_id_check,
  add constraint allrice_platform_maintenance_defects_repository_id_check
    check (repository_id = 1469490636);
