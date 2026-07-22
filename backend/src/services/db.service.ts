import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export async function connectDB() {
  try {
    await prisma.$connect();
    console.log("✓ Database connected");
  } catch (err) {
    console.error("✗ Database connection failed:", (err as Error).message);
    throw err;
  }
}

export async function disconnectDB() {
  await prisma.$disconnect();
}
