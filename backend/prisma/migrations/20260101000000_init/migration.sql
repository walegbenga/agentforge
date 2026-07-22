-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "onChainTaskId" INTEGER,
    "requesterAddress" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "totalBudget" INTEGER NOT NULL,
    "allocatedBudget" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "txHashes" JSONB NOT NULL DEFAULT '{}',
    "orchestrationLog" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subtask" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "subtaskIndex" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "budget" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "deliverableHash" TEXT,
    "deliverable" TEXT,
    "onChainSubtaskIndex" INTEGER,
    "assignedAgentId" TEXT,
    "assignedAgentName" TEXT,
    "assignedAgentWallet" TEXT,
    "assignedAgentRep" INTEGER,
    "error" TEXT,
    "assignedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subtask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_requesterAddress_idx" ON "Task"("requesterAddress");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Subtask_taskId_idx" ON "Subtask"("taskId");
CREATE INDEX "Subtask_status_idx" ON "Subtask"("status");

-- AddForeignKey
ALTER TABLE "Subtask" ADD CONSTRAINT "Subtask_taskId_fkey" 
FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
