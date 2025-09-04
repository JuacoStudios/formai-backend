"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEntitlementByDevice = getEntitlementByDevice;
exports.getOrCreateUsage = getOrCreateUsage;
exports.incrementScanUsage = incrementScanUsage;
exports.canPerformScan = canPerformScan;
const prisma_1 = require("../db/prisma");
/**
 * Get entitlement status for a device
 */
async function getEntitlementByDevice(deviceId) {
    // Find latest active subscription for this device
    const subscription = await prisma_1.prisma.subscription.findFirst({
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
    const result = {
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
async function getOrCreateUsage(deviceId) {
    const usage = await prisma_1.prisma.usageCounter.upsert({
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
async function incrementScanUsage(deviceId) {
    const usage = await prisma_1.prisma.usageCounter.upsert({
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
async function canPerformScan(deviceId) {
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
