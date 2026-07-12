import { requireNativeData } from "./client";
import type {
  CatalogLatestQueryArgs,
  CatalogPageQueryArgs,
  CatalogProductsByIdsArgs,
  CatalogConfirmMutationsArgs,
  CatalogConfirmMutationsResult,
  CatalogRecordLiveObservationsArgs,
  CatalogRecordLiveObservationsResult,
  CatalogRecordMutationResultsArgs,
  CatalogRecordMutationResultsResult,
  CursorPage,
  NativeDataHealthResult,
  ProductCatalogLatestV2,
  ProductCatalogRunMemberV2
} from "./types";

export async function getCatalogStorageHealth(): Promise<NativeDataHealthResult> {
  return requireNativeData().maintenance.getHealth();
}

export async function queryHeadMembersPage(args: CatalogPageQueryArgs): Promise<CursorPage<ProductCatalogRunMemberV2>> {
  return requireNativeData().catalog.queryHeadMembersPage(args);
}

export async function queryLastObservedPage(args: CatalogLatestQueryArgs): Promise<CursorPage<ProductCatalogLatestV2>> {
  return requireNativeData().catalog.queryLastObservedPage(args);
}

export async function getProductsByIds(args: CatalogProductsByIdsArgs): Promise<ProductCatalogLatestV2[]> {
  return requireNativeData().catalog.getProductsByIds(args);
}

export async function recordLiveObservations(args: CatalogRecordLiveObservationsArgs): Promise<CatalogRecordLiveObservationsResult> {
  return requireNativeData().catalog.recordLiveObservations(args);
}

export async function recordMutationResults(args: CatalogRecordMutationResultsArgs): Promise<CatalogRecordMutationResultsResult> {
  return requireNativeData().catalog.recordMutationResults(args);
}

export async function confirmMutations(args: CatalogConfirmMutationsArgs): Promise<CatalogConfirmMutationsResult> {
  return requireNativeData().catalog.confirmMutations(args);
}
