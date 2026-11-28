import { ChatSessionSchema } from './workspace.ts';
import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { MAX_PERSON_VM_EMPLOYEE_PORT_SLOTS } from './platform-person-vm-configuration.ts';

// Product writer ownership, independent of the installed DSH distribution.
export const ExecutionGenerationSchema = z.enum(['3.x', '4.0']);
export type ExecutionGeneration = z.infer<typeof ExecutionGenerationSchema>;

// Selectors only. Tenant/person/native owner and transport targets are host facts.
export const DEntrySelectionInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeInstanceId: UuidSchema,
    threadId: UuidSchema.optional(),
  })
  .strict();
export type DEntrySelectionInput = z.infer<typeof DEntrySelectionInputSchema>;

export const DEntryIdentitySchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    personId: UuidSchema,
    employeeInstanceId: UuidSchema,
    employeeRevision: z.number().int().positive(),
    employeeVersionId: UuidSchema,
    threadId: UuidSchema.nullable(),
  })
  .strict();
export type DEntryIdentity = z.infer<typeof DEntryIdentitySchema>;
export function sameDEntryIdentity(a: DEntryIdentity, b: DEntryIdentity) {
  return (
    [
      'organizationId',
      'workspaceId',
      'personId',
      'employeeInstanceId',
      'employeeRevision',
      'employeeVersionId',
      'threadId',
    ] as const
  ).every((key) => a[key] === b[key]);
}
export const DEntryIdentityResultSchema = z
  .object({ identity: DEntryIdentitySchema })
  .strict();
export const DEntryAdmissionSchema = z
  .object({
    identity: DEntryIdentitySchema,
    executionGeneration: ExecutionGenerationSchema,
    policyRevision: z.string().min(1),
  })
  .strict();
export type DEntryAdmission = z.infer<typeof DEntryAdmissionSchema>;

// No env/default/list is created here. The approved release source must supply
// every field. Matching one person's employee never grants another's access.
const RolloutUuidSchema = UuidSchema.transform((id) => id.toLowerCase());
export const DEntryRolloutPolicySchema = z
  .object({
    revision: z.string().min(1),
    defaultGeneration: ExecutionGenerationSchema,
    selections: z.array(
      z
        .object({
          organizationId: RolloutUuidSchema,
          personId: RolloutUuidSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const people = new Set<string>();
    for (const [index, selection] of policy.selections.entries()) {
      const key = JSON.stringify([
        selection.organizationId,
        selection.personId,
      ]);
      if (people.has(key))
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate person selection',
          path: ['selections', index],
        });
      people.add(key);
    }
  });
export type DEntryRolloutPolicy = z.infer<typeof DEntryRolloutPolicySchema>;

export function hasDEntryPersonRelease(
  policy: DEntryRolloutPolicy,
  identity: Pick<DEntryIdentity, 'organizationId' | 'personId'>,
) {
  const organizationId = identity.organizationId.toLowerCase();
  const personId = identity.personId.toLowerCase();
  return policy.selections.some(
    (selection) =>
      selection.organizationId === organizationId &&
      selection.personId === personId,
  );
}

/** Selects a NEW thread's writer only; never changes a persisted thread pin. */
export function selectDEntryGeneration(
  policyInput: DEntryRolloutPolicy,
  identityInput: DEntryIdentity,
): ExecutionGeneration {
  const policy = DEntryRolloutPolicySchema.parse(policyInput);
  const identity = DEntryIdentitySchema.parse(identityInput);
  return hasDEntryPersonRelease(policy, identity) ? '4.0' : '3.x';
}

// Browser-safe mount references only; no guest URL, cookie, token or disk path.
// The runtime owner supplies an opaque binding reference that changes whenever
// the Host/profile/lease changes. The BFF alone resolves its transport.
export const DEntryMountSchema = z
  .object({
    identity: DEntryIdentitySchema,
    executionGeneration: ExecutionGenerationSchema,
    bindingRef: z.string().min(1),
    remountKey: z.string().min(1),
  })
  .strict();
export type DEntryMount = z.infer<typeof DEntryMountSchema>;

// 271-owned wire boundary for the frozen native-owner v1 discovery seam.
// These schemas validate a consumed projection; they do not construct or
// replace 273's provider receipt or attest that a native job is ready.
export const DEntryNativeOwnerRequestSchema = z
  .object({
    organizationId: UuidSchema,
    selection: DEntrySelectionInputSchema,
  })
  .strict();
// Page locators carry no authority. Borrowers must present the original login.
export const DEntryPageScopeReferenceSchema = z
  .object({ scopeId: UuidSchema })
  .strict();
export const DEntryPageOpenedSchema = z
  .object({
    type: z.literal('opened'),
    scopeReference: DEntryPageScopeReferenceSchema,
    bindingRef: z.string().min(1),
  })
  .strict();
export const DEntryPageClosedSchema = z
  .object({ type: z.literal('closed'), scopeId: UuidSchema })
  .strict();
export const DEntryPageSwitchSchema = z.strictObject({
  type: z.literal('switch'),
  requestId: UuidSchema,
  threadId: UuidSchema,
});
export const DEntryPageSwitchResultSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('switched'),
    requestId: UuidSchema,
    threadId: UuidSchema,
    scopeId: UuidSchema,
    nativeSessionId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('switch-unavailable'),
    requestId: UuidSchema,
  }),
]);
export const DEntryPageMuxQuerySchema = DEntrySelectionInputSchema.extend({
  carrier: z.literal('page'),
  organizationId: UuidSchema,
  scopeId: UuidSchema.optional(),
});
// Connection's canonical namespace/method syntax. A caller can name a method
// here, but only the admitted guest can resolve and authorize its descriptor.
export const DEntryPageUnarySchema = z
  .string()
  .regex(/^[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/u);
// Only an acknowledged, currently authorized page create/fork may carry this
// AllRice thread id. The DSH reply body and rpcId keep their original contract.
export const dEntryRegisteredThreadHeader = 'x-allrice-d-entry-thread';
export const dEntryWarmIdentityHeader = 'x-allrice-d-entry-identity';
export function decodeDEntryRegisteredThread(header: string | null) {
  if (!header || header.length > 4096) return;
  try {
    const thread = ChatSessionSchema.safeParse(
      JSON.parse(decodeURIComponent(header)),
    );
    if (thread.success) return thread.data;
  } catch {
    // Optional presentation receipt; the DSH response remains authoritative.
  }
}

export const DEntryPageRpcRequestSchema = DEntryPageScopeReferenceSchema.extend(
  {
    selection: DEntrySelectionInputSchema,
    rpcId: z.string(),
    endpoint: DEntryPageUnarySchema,
    payload: z.object({ args: z.record(z.string(), z.unknown()) }).strict(),
  },
);

export const DEntryPageBorrowSchema = DEntrySelectionInputSchema.extend({
  scopeId: UuidSchema,
});
export const DEntryPageSwitchProofSchema = DEntryPageBorrowSchema.extend({
  dispatch: z.literal('direct').optional(),
  requestId: UuidSchema,
  targetThreadId: UuidSchema,
});
const profileToken = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
export const DEntryProfileBindingSchema = DEntryPageBorrowSchema.extend({
  bindingRef: profileToken,
});
export const DEntryProfileAssetSchema = DEntryProfileBindingSchema.extend({
  reference: z.string().min(1).max(16384),
  revision: profileToken,
});
export const DEntryProfileChunkFilenameSchema = z
  .string()
  .regex(/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u)
  .refine(
    (file) => file !== 'client.node.js' && !file.startsWith('client.node.'),
  );
export const DEntryProfileAddressSchema = z.strictObject({
  bindingRef: profileToken,
  graphRev: profileToken,
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const profileEntry = z.strictObject({
  id: z.string().min(1),
  url: z.string().startsWith('plugins/??'),
  rev: profileToken,
  inject: z.array(z.string()).optional(),
  immediately: z.boolean().optional(),
  external: z.array(z.string()).optional(),
});
export const DEntryProfileGraphSchema = z.strictObject({
  rev: profileToken,
  release: z.strictObject({
    version: z.string().min(1),
    commit: z.string().min(1).optional(),
  }),
  entries: z.array(profileEntry).min(1),
  batches: z
    .array(
      z.strictObject({
        phase: z.enum(['bootstrap', 'application']),
        url: z.string().startsWith('plugins/??'),
        rev: profileToken,
        entries: z.array(z.string()).min(1),
      }),
    )
    .min(1),
});
export const DEntryProfileInjectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('script'),
    placement: z.literal('head'),
    text: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('script-src'),
    placement: z.literal('head'),
    src: z.string().startsWith('plugins/??'),
  }),
  z.strictObject({
    kind: z.literal('script-preload'),
    src: z.string().startsWith('plugins/??'),
  }),
  z.strictObject({
    kind: z.literal('global'),
    name: z.enum(['__DSH_BOOT__', '__DSH_REMOTE_ACCESS__']),
    value: z.json(),
  }),
]);
export const DEntryProfileBootstrapSchema = z.strictObject({
  version: z.literal(1),
  scopeReference: DEntryPageScopeReferenceSchema,
  bindingRef: profileToken,
  graph: DEntryProfileGraphSchema,
  injections: z.array(DEntryProfileInjectionSchema).min(1),
});

/** Private Web-to-Worker document response from the same published scope. */
export const DEntryProfileDocumentSchema = z.strictObject({
  address: DEntryProfileAddressSchema.extend({
    nativeSessionId: z.string().min(1),
  }),
  bootstrap: DEntryProfileBootstrapSchema,
});
export const DEntryProfileFilePathSchema = z
  .string()
  .regex(/^[0-9A-Za-z_@.+()/-]{1,512}$/)
  .refine((path) =>
    path.split('/').every((part) => part && part !== '.' && part !== '..'),
  );

export const DEntryNativePrewarmTriggerSchema = z.enum([
  'page',
  'input',
  'open',
]);
export type DEntryNativePrewarmTrigger = z.infer<
  typeof DEntryNativePrewarmTriggerSchema
>;
export const DEntryNativePrewarmInputSchema = z
  .object({
    selection: DEntrySelectionInputSchema,
    trigger: DEntryNativePrewarmTriggerSchema,
  })
  .strict();
export const DEntryNativePrewarmRequestSchema =
  DEntryNativeOwnerRequestSchema.extend({
    trigger: DEntryNativePrewarmTriggerSchema,
  });
/** Internal acknowledgement only; never editor/send/control readiness. */
export const DEntryNativePrewarmResultSchema = z
  .object({
    identity: DEntryIdentitySchema,
    trigger: DEntryNativePrewarmTriggerSchema,
  })
  .strict();
export const DEntryNativePrewarmTicketSchema = z
  .object({
    operationId: UuidSchema,
    expiresAt: z.iso.datetime(),
    pollAfterMs: z.number().int().min(1000).max(3000),
  })
  .strict();
export const DEntryNativePrewarmAcceptedSchema =
  DEntryNativePrewarmResultSchema.extend({
    ticket: DEntryNativePrewarmTicketSchema,
  });
export const DEntryNativePrewarmStatusQuerySchema =
  DEntrySelectionInputSchema.extend({ operationId: UuidSchema });
export const DEntryNativePrewarmStatusSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.enum(['accepted', 'starting', 'restarting', 'ready', 'expired']),
    })
    .strict(),
  z
    .object({
      state: z.literal('waiting_for_capacity'),
      activeLimit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PERSON_VM_EMPLOYEE_PORT_SLOTS),
    })
    .strict(),
  z
    .object({
      state: z.literal('failed'),
      code: z.enum([
        'START_UNAVAILABLE',
        'AUTHORITY_REVOKED',
        'UPGRADE_OPEN_REQUIRED',
      ]),
    })
    .strict(),
]);
export type DEntryNativePrewarmTicket = z.infer<
  typeof DEntryNativePrewarmTicketSchema
>;
export type DEntryNativePrewarmStatus = z.infer<
  typeof DEntryNativePrewarmStatusSchema
>;
export const DEntryNativeResourceRequestSchema = z
  .object({
    organizationId: UuidSchema,
    selection: DEntrySelectionInputSchema.extend({ threadId: UuidSchema }),
    nativeSessionId: z.string().min(1),
  })
  .strict();
export const DEntryNativeResourceFactsSchema = z
  .object({
    organizationId: UuidSchema,
    personId: UuidSchema,
    employeeInstanceId: UuidSchema,
    threadId: UuidSchema,
    nativeSessionId: z.string().min(1),
    rootNativeSessionId: z.string().min(1),
    parentNativeSessionId: z.string().min(1).nullable(),
    bindingRef: z.string().min(1),
  })
  .strict();
export type DEntryNativeResourceFacts = z.infer<
  typeof DEntryNativeResourceFactsSchema
>;

export const DEntryNativeRpcRequestSchema = z
  .object({
    selection: DEntrySelectionInputSchema.extend({ threadId: UuidSchema }),
    endpoint: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();
export const DEntryNativeDiscoverySchema = z
  .object({
    identity: DEntryIdentitySchema,
    bindingRef: z.string().min(1),
    controlReady: z.boolean(),
  })
  .strict();
