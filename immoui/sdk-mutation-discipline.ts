/**
 * SDK mutation discipline — composition of core primitives.
 *
 * Every useMutation() call must implement the full lifecycle:
 * onMutate, onError, and onSettled or onSuccess.
 */
import { select } from '@regeln/core';
import { requireCallShape } from '@regeln/typescript';

export const sdkMutationDiscipline = select(
  'src/sdk/**/hooks/use-{create,update,delete,move,duplicate,restore}-*.ts',
)
  .label('SDK mutation hooks must implement onMutate, onError, and onSettled lifecycle')
  .check(requireCallShape('useMutation', ['onMutate', 'onError', 'onSettled']));
