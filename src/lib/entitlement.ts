import { prisma } from '../db/prisma';

export interface EntitlementResult {
  active: boolean;
  expiresAt?: number;
  scansUsed: number;
  limit: number;
}

export interface UsageResult {
  scansUsed: number;
  limit: number;
}

/**
 * Get entitlement status for a device
 */
export async function getEntitlementByDevice(deviceId: string): Promise<EntitlementResult> {
  // Find latest active subscription for this device
  const subscription = await prisma.subscription.findFirst({
    where: {
      deviceId,
      status: {
        in: ['active', 'trialing']
      },
      currentPeriodEnd: {
        gt: new Date()
      }
    },
    orderBy: {
      createdAt: 'desc'
    }
  });

  // Get usage counter for this device
  const usage = await getOrCreateUsage(deviceId);

  const result: EntitlementResult = {
    active: !!subscription,
    scansUsed: usage.scansUsed,
    limit: 1 // Free tier limit
  };

  if (subscription?.currentPeriodEnd) {
    result.expiresAt = subscription.currentPeriodEnd.getTime();
  }

  return result;
}

/**
 * Get or create usage counter for a device
 */
export async function getOrCreateUsage(deviceId: string): Promise<UsageResult> {
  const usage = await prisma.usageCounter.upsert({
    where: {
      deviceId
    },
    update: {},
    create: {
      deviceId,
      scansUsed: 0
    }
  });

  return {
    scansUsed: usage.scansUsed,
    limit: 1
  };
}

/**
 * Increment scan usage for a device
 */
export async function incrementScanUsage(deviceId: string): Promise<UsageResult> {
  const usage = await prisma.usageCounter.upsert({
    where: {
      deviceId
    },
    update: {
      scansUsed: {
        increment: 1
      }
    },
    create: {
      deviceId,
      scansUsed: 1
    }
  });

  return {
    scansUsed: usage.scansUsed,
    limit: 1
  };
}

/**
 * Check if device can perform a scan
 */
export async function canPerformScan(deviceId: string): Promise<{ canScan: boolean; reason?: string }> {
  const entitlement = await getEntitlementByDevice(deviceId);
  
  // If user has active subscription, they can scan unlimited
  if (entitlement.active) {
    return { canScan: true };
  }
  
  // If user hasn't used their free scan, they can scan once
  if (entitlement.scansUsed === 0) {
    return { canScan: true };
  }
  
  // Otherwise, they need to subscribe
  return { 
    canScan: false, 
    reason: 'limit_exceeded' 
  };
}
