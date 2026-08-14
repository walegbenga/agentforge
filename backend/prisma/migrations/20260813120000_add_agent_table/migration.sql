-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "onChainTaskId" TEXT,
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
    "disputeReason" TEXT,
    "retryOf" INTEGER,
    "retryCount" INTEGER DEFAULT 0,
    "assignedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subtask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "capabilities" TEXT[],
    "walletAddress" TEXT NOT NULL,
    "pricePerTask" INTEGER NOT NULL,
    "reputationScore" INTEGER NOT NULL DEFAULT 70,
    "jobsCompleted" INTEGER NOT NULL DEFAULT 0,
    "totalEarned" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_requesterAddress_idx" ON "Task"("requesterAddress");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Subtask_taskId_idx" ON "Subtask"("taskId");

-- CreateIndex
CREATE INDEX "Subtask_status_idx" ON "Subtask"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_name_key" ON "Agent"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_walletAddress_key" ON "Agent"("walletAddress");

-- CreateIndex
CREATE INDEX "Agent_walletAddress_idx" ON "Agent"("walletAddress");

-- CreateIndex
CREATE INDEX "Agent_active_idx" ON "Agent"("active");

-- AddForeignKey
ALTER TABLE "Subtask" ADD CONSTRAINT "Subtask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

