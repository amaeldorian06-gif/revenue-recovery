import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * The tripwire.
 *
 * Invariant I2 says the arm is frozen at import: moving a dossier into or out of
 * the holdout after the fact would let anyone manufacture the result they want.
 * No endpoint should exist for this, so this file exists *only* to answer 403 with
 * a reason — a 404 would look like a missing feature, and someone would implement
 * it. The database trigger is the real lock; this route is the sign on the door.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: 'arm_immutable',
      detail:
        'Le groupe (traitement / témoin) est figé à l’import. Déplacer un dossier après coup rendrait toute mesure complaisante.',
    },
    { status: 403 },
  );
}

export async function PUT() {
  return POST();
}

export async function PATCH() {
  return POST();
}
