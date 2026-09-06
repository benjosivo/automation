-- 002_autom_runner.sql
--
-- Several runner processes share one database. Without this column each of them
-- loads every active schedule: every cron fires once per process, every runner
-- tries to load modules it does not ship, and one runner's boot recovery marks
-- the other's live runs as timed out.
--
-- DEFAULT 'default' keeps every existing task with the original runner. Only the
-- rows reassigned explicitly change owner.

ALTER TABLE `Autom_Task`
    ADD COLUMN `Runner` VARCHAR(45) NOT NULL DEFAULT 'default' AFTER `Name`,
    ADD INDEX `idx_Autom_Task_Runner` (`Runner`);
