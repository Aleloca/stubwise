-- Area 11, review di F2 (M4): l'ancora di un filo PRIMA che un `merge` lo
-- spostasse sul blocco unito. Il ⌘Z di quel merge rimette il blocco assorbito,
-- e con questa colonna i suoi fili tornano su di lui. Null = il filo è dove è
-- nato (o vi è tornato).
ALTER TABLE "product_comments" ADD COLUMN "original_anchor_id" text;
