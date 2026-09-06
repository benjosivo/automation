CREATE TABLE `Autom_Schedule` (
  `idAutom_Schedule` int NOT NULL AUTO_INCREMENT,
  `Autom_Task_id` int NOT NULL,
  `CronExpression` varchar(45) NOT NULL,
  `isActive` tinyint NOT NULL DEFAULT '0',
  `CreatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `UpdatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`idAutom_Schedule`),
  KEY `fk_Autom_Schedule_Autom_Task1_idx` (`Autom_Task_id`),
  CONSTRAINT `fk_Autom_Schedule_Autom_Task1` FOREIGN KEY (`Autom_Task_id`) REFERENCES `Autom_Task` (`idAutom_Task`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `Autom_Task` (
  `idAutom_Task` int NOT NULL AUTO_INCREMENT,
  `Name` varchar(45) NOT NULL,
  `Description` varchar(255) NOT NULL,
  `ModulePath` varchar(128) NOT NULL,
  `isActive` tinyint NOT NULL DEFAULT '0',
  `ConcurrencyGroup` varchar(45) DEFAULT NULL,
  `RetryLimit` int NOT NULL DEFAULT '0',
  `RetryDelaySeconds` int NOT NULL DEFAULT '60',
  `CreatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `UpdatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`idAutom_Task`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `Autom_Task_Lock` (
  `idAutom_Task_Lock` int NOT NULL AUTO_INCREMENT,
  `ConcurrencyGroup` varchar(45) NOT NULL,
  `Autom_Task_Run_id` int DEFAULT NULL,
  `LockedAt` datetime NOT NULL,
  PRIMARY KEY (`idAutom_Task_Lock`),
  KEY `fk_Autom_Task_Lock_Autom_Task_Run1_idx` (`Autom_Task_Run_id`),
  CONSTRAINT `fk_Autom_Task_Lock_Autom_Task_Run1` FOREIGN KEY (`Autom_Task_Run_id`) REFERENCES `Autom_Task_Run` (`idAutom_Task_Run`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `Autom_Task_Run` (
  `idAutom_Task_Run` int NOT NULL AUTO_INCREMENT,
  `Autom_Task_id` int NOT NULL,
  `Autom_Schedule_id` int DEFAULT NULL,
  `Status` enum('pending','running','completed','failed','timeout') NOT NULL,
  `TriggeredBy` enum('scheduler','api','manual') NOT NULL,
  `Attempt` int NOT NULL DEFAULT '1',
  `StartedAt` datetime NOT NULL,
  `FinishedAt` datetime DEFAULT NULL,
  `Output` mediumtext,
  `ErrorMessage` text,
  PRIMARY KEY (`idAutom_Task_Run`),
  KEY `fk_Autom_Task_Run_Autom_Schedule1_idx` (`Autom_Schedule_id`),
  KEY `fk_Autom_Task_Run_Autom_Task1_idx` (`Autom_Task_id`),
  CONSTRAINT `fk_Autom_Task_Run_Autom_Schedule1` FOREIGN KEY (`Autom_Schedule_id`) REFERENCES `Autom_Schedule` (`idAutom_Schedule`),
  CONSTRAINT `fk_Autom_Task_Run_Autom_Task1` FOREIGN KEY (`Autom_Task_id`) REFERENCES `Autom_Task` (`idAutom_Task`)
) ENGINE=InnoDB AUTO_INCREMENT=2998 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
