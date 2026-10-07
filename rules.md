# Werewolf (Mafia) — Game Rules & Guide for Kids

**Werewolf** (also known as *Mafia*) is a fun party game of secret identities, deduction, and bluffing. One team tries to protect the village, while the secret Werewolves try to take over!

---

## Game Setup

### Role Cards Checklist

| Role | Count in the Chat Game |
| :--- | :--- |
| **Moderator** | The bot; does not take a player seat |
| **Werewolf** | `max(1, floor(player_count / 3))` |
| **Doctor** | 0 or 1, chosen from the special-role pool |
| **Seer** | 0 or 1, chosen from the special-role pool |
| **Hunter** | 0 or 1, chosen from the special-role pool |
| **Witch** | 0 or 1, chosen from the special-role pool |
| **Villager** | All remaining seats |

---

For the chat game, the engine is the moderator and does not take a seat. Games have at least 5 players and `max(1, player_count / 3)` Werewolves (rounded down). Among the non-Werewolf players, up to `max(2, floor(village_count × 33%))` receive special roles, chosen randomly without replacement from Doctor, Seer, Hunter, and Witch. If all four fit, all are included; remaining seats are ordinary Villagers.

## The Roles Explained

* 🧑‍🌾 **Villagers:** The innocent townsfolk. They do not have night actions, but during the day they listen to clues, debate, and vote to catch the Werewolves.
* 🐺 **Werewolves:** The secret villains. They wake up together each night and silently pick one player to eliminate. During the day, they blend in and pretend to be innocent Villagers.
* 🩺 **Doctor:** The protector. Wakes up each night and chooses one player to save. If the Werewolves target that person, they are saved and stay in the game!
* 🔮 **Seer:** The detective. May inspect one living player privately during Day 1, their only daytime inspection, then wakes up each night to inspect one player. The Day 1 inspection is skipped if Day 1 ends first. The Moderator secretly reveals if that person is a Werewolf or innocent.
* 🏹 **Hunter:** The village's last-shot defender. Has no night action, but when eliminated by a vote, the Werewolves, or the Witch's poison, chooses one living player to eliminate with a final shot.
* 🧪 **Witch:** The potion-maker. Holds one healing potion and one poison for the whole game. Each night, after the Werewolves choose, she may heal their target, poison another player, or do nothing.

The Doctor, Seer, Hunter, and Witch are all on the village team. Special roles are randomly selected, so not every game includes every role.

---

### Hunter (Chat Game)

The **Hunter** is on the village team and replaces one Villager in the chat roster. They have no night action. When eliminated by a vote, the Werewolves, or the Witch's poison, they must choose one living player to eliminate with a final shot using their DM dropdowns. A Hunter who is both attacked and poisoned on the same night shoots once. A saved or healed Hunter does not shoot. The shot cannot be protected by the Doctor or healed by the Witch.

Play pauses and victory checks wait until the shot is taken, even if the Hunter's death would give the wolves parity. After the shot, check for a winner; otherwise continue to night after a daytime elimination, or the next numbered day after a nighttime elimination. The Hunter then becomes a spectator.

### Witch (Chat Game)

The **Witch** is on the village team and replaces one Villager in the chat roster. She holds **one healing potion** and **one poison**, each usable once per game.

* **Her turn comes last.** Once the Werewolves have agreed on a target and the Doctor and Seer have acted, the pack's choice is locked and the Witch is prompted privately. Nothing is announced publicly until she has chosen.
* **One choice per night:** heal the attacked player, poison one other living player, or do nothing. She can never use both potions on the same night, and her choice is final.
* **Healing:** While she still holds the healing potion, the Witch is told who the Werewolves attacked. She may heal anyone, including herself. If the Doctor already protected that player, the heal is still spent. Once the healing potion is spent she is no longer told who was attacked.
* **Poison:** Eliminates any other living player at dawn; she cannot poison herself. The Doctor's protection does not stop it. A poisoned player's role is revealed like any other elimination.
* **A night can eliminate two players:** the Werewolves' target and the poisoned player. The morning report names who died but never how.
* A Witch attacked by the Werewolves still takes her turn that night. A Witch who is dead, or who has spent both potions, has no turn and the night resolves without waiting.

## How to Play

After roles are assigned privately, **the game starts immediately on Day 1**. Public messages do not reveal whether a Seer exists or has acted.

**Day 1 Seer action:** If present, the Seer may use DM dropdowns to inspect one living player (including themselves) at any time during Day 1, alongside discussion and voting. This is the **only time the Seer can inspect during the day**. Only the Seer receives whether that player is a Werewolf or innocent, not the exact innocent role. The choice is final and does not affect the vote. If Day 1 ends before the Seer acts, the Day 1 inspection is skipped with no public announcement. DM `status` recovers the Seer's private inspection history, labeled **Day 1** or **Night N**, and any current prompt.

Play alternates **Day 1 → Night 1 → Day 2 → Night 2**, until one team wins. Taking or skipping the Day 1 inspection does not use up the Seer's Night 1 action.

### 1. Day Phase (Eyes Open)

1. **Opening Day:** The Moderator announces that the game has begun. Everyone is alive and there is no overnight report on Day 1. The Seer may take their one daytime inspection now.
2. **Later Mornings:** The Moderator announces what happened during the preceding night:
   * *If saved:* "The Werewolves attacked Alex, but they were saved! No one was eliminated." The report does not say whether the Doctor or the Witch saved them.
   * *If not saved:* "Sadly, Jamie was eliminated during the night!" *(Jamie silently shows their card and becomes a quiet spectator).*
   * *If the Witch used her poison:* the poisoned player is announced the same way, so a morning can report two eliminations, or a save and an elimination.
3. **Town Discussion:** Players discuss who seems suspicious, who might be lying, or what clues were spotted. Voting is available throughout the day, including Day 1.
4. **The Vote:**
   * In the game channel, a living player votes with **`@werewolf vote @player`**, mentioning the player they suspect.
   * Each living player has one vote. Repeating the command with a different target changes that vote until the day resolves.
   * As soon as **more than half of the living players** vote for the same player (for example, 4 of 7 or 4 of 6), that player is eliminated and their role is revealed. There is no need to wait for everyone to vote.
   * Otherwise, as soon as **every living player has voted**, the player with the **most votes** is eliminated and their role is revealed, even without a majority.
   * If two or more players tie for the most votes after everyone has voted, **nobody is eliminated** and night begins. A tie does not trigger a Hunter shot.
   * Until a majority is reached or everyone has voted, discussion and vote changes remain open. Votes reset each day.
   * If neither team has won, night begins immediately with the same round number.

---

### 2. Night Phase (Eyes Closed)

The Moderator speaks aloud while everyone keeps their eyes tightly shut:

1. **"Night falls on the village. Everyone close your eyes!"**
2. **"Werewolves, open your eyes and pick your target."**  
   *(Werewolves open eyes, point silently to one victim, then close eyes). If only one Werewolf is alive, they cannot target themselves.*
3. **"Doctor, open your eyes and choose someone to save."**  
   *(Doctor opens eyes, points to one player—can be themselves—then closes eyes). The choice is final for that night and protection expires at dawn.*
4. **"Seer, open your eyes and pick someone to inspect."**  
   *(Seer opens eyes, points to one living player. The Moderator privately reveals 👍 [Innocent] or 👎 [Werewolf], without revealing the exact innocent role. Seer closes eyes). One inspection per night; the choice is final.*
5. **"Witch, open your eyes. This player was attacked. Will you heal them, poison someone, or do nothing?"**  
   *(Witch opens eyes. If she still holds the healing potion, the Moderator points to the Werewolves' target. She uses at most one potion, then closes eyes). The choice is final.*

In chat, the Werewolves, Doctor, and Seer can submit their choices in any order. If the Werewolves disagree, only the pack chooses again; protection and inspection choices remain in place. Once the pack agrees and the others have acted, the pack's target is locked and a Witch who still holds a potion takes her turn. The night resolves after all have acted, so a player targeted by the Werewolves still gets their night action.

After the night actions resolve, check for a winner. If the game continues, begin the next numbered day.

---

## How to Win

* 🧑‍🌾 **Village Team Wins:** When all Werewolves have been successfully eliminated! Villagers, the Doctor, the Seer, the Hunter, and the Witch win together.
* 🐺 **Werewolves Win:** When the number of living Werewolves equals or exceeds the number of all other living players, including special village roles.

All of a night's eliminations happen together at dawn, before either victory condition is checked; poisoning the last Werewolf wins the game for the village even if the pack's attack also lands. If the Hunter has a final shot pending, resolve it before checking either victory condition.

---

## Quick Tips for Playing with Kids

1. **Keep it Light:** Remind eliminated players that they are still part of the fun as "ghost observers."
2. **Prevent Peeking:** Ask kids to tap their knees gently on their lap during the night phase to create noise and disguise movement.
3. **Short Debates:** Set a 3-minute timer for the daytime discussion to keep the game moving fast!
