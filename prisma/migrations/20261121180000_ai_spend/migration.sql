-- CreateTable
CREATE TABLE "AiSpend" (
    "month" TEXT NOT NULL,
    "spentMicros" BIGINT NOT NULL DEFAULT 0,
    "reservedMicros" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "AiSpend_pkey" PRIMARY KEY ("month")
);
