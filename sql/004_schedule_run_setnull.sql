-- 004_schedule_run_setnull.sql
--
-- REQUIRED as soon as anything can delete a schedule. Apply it with the rest.
--
-- 001 declares fk_Autom_Task_Run_Autom_Schedule1 with no ON DELETE clause, so
-- MySQL applies RESTRICT. Every run a schedule has ever produced therefore holds
-- it hostage: DELETE /schedules/:id succeeds only on a schedule that has never
-- fired, and on any other one the raw MySQL error reaches the caller inside a
-- 500. The defect was invisible for as long as nothing offered a delete button.
--
-- SET NULL is the right disposal rather than CASCADE: a run is a historical fact
-- and deleting the schedule that caused it must not erase it. Autom_Schedule_id
-- is already nullable, and the API and the dashboard both already render a run
-- whose schedule is NULL -- it is what a manually triggered run looks like.
--
-- The constraint name is reused, so this migration is not idempotent: the DROP
-- fails if it has already run. Check first when in doubt:
--
--   SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
--    WHERE CONSTRAINT_NAME = 'fk_Autom_Task_Run_Autom_Schedule1'
--      AND CONSTRAINT_SCHEMA = DATABASE();

ALTER TABLE `Autom_Task_Run`
    DROP FOREIGN KEY `fk_Autom_Task_Run_Autom_Schedule1`;

ALTER TABLE `Autom_Task_Run`
    ADD CONSTRAINT `fk_Autom_Task_Run_Autom_Schedule1`
        FOREIGN KEY (`Autom_Schedule_id`) REFERENCES `Autom_Schedule` (`idAutom_Schedule`)
        ON DELETE SET NULL;
