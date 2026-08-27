import { PrismaClient } from "@prisma/client";

type PrismaGlobal = typeof globalThis & { __noblePayPrisma?: PrismaClient };
const prismaGlobal = globalThis as PrismaGlobal;

function createPrismaClient(): PrismaClient {
  const environment = process.env.NODE_ENV || "development";
  return new PrismaClient({
    log:
      environment === "development"
        ? [
            { emit: "event", level: "query" },
            { emit: "event", level: "error" },
          ]
        : [{ emit: "event", level: "error" }],
  });
}

/** One lazy-connecting Prisma pool shared by all NoblePay transports. */
export const prisma = prismaGlobal.__noblePayPrisma || createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  prismaGlobal.__noblePayPrisma = prisma;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
