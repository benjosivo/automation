-- 003_autom_lock_unique.sql
--
-- OPTIONAL, AND IT CHANGES PRODUCTION BEHAVIOUR. Read before applying.
--
-- acquireLock() runs an INSERT ... ON DUPLICATE KEY UPDATE keyed on
-- ConcurrencyGroup, but the table created by 001 carries no uniqueness
-- constraint on that column. The duplicate branch therefore never fires: every
-- acquisition inserts a fresh row, affectedRows comes back as 1, and the lock
-- grants access to everyone. The concurrency group protects nothing as it
-- stands.
--
-- This migration makes the lock real. The consequence is that two tasks sharing
-- a ConcurrencyGroup stop running in parallel -- which is the intent, but it is
-- a change in what the machine does, on a schedule nobody watches at 3am.
--
-- Check for existing duplicates first, or the ALTER fails:
--
--   SELECT ConcurrencyGroup, COUNT(*) FROM Autom_Task_Lock
--    GROUP BY ConcurrencyGroup HAVING COUNT(*) > 1;
--
--   DELETE l1 FROM Autom_Task_Lock l1
--     JOIN Autom_Task_Lock l2
--       ON l1.ConcurrencyGroup = l2.ConcurrencyGroup
--      AND l1.idAutom_Task_Lock > l2.idAutom_Task_Lock;

ALTER TABLE `Autom_Task_Lock`
    ADD UNIQUE KEY `uq_Autom_Task_Lock_ConcurrencyGroup` (`ConcurrencyGroup`);
