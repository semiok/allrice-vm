-- Retire every historical DSH-native Skill and employee binding. The new
-- platform Skill registry intentionally starts empty.
delete from allrice_employee_dsh_skill_bindings;
delete from allrice_dsh_skills;
delete from allrice_platform_dsh_skills;
