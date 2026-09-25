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
| **Villager** | All remaining seats |

---

For the chat game, the engine is the moderator and does not take a seat. Games have at least 5 players and `max(1, player_count / 3)` Werewolves (rounded down). Among the non-Werewolf players, up to `max(2, floor(village_count × 33%))` receive special roles, chosen randomly without replacement from Doctor, Seer, and Hunter. If all three fit, all are included; remaining seats are ordinary Villagers.

## The Roles Explained

* 🧑‍🌾 **Villagers:** The innocent townsfolk. They do not have night actions, but during the day they listen to clues, debate, and vote to catch the Werewolves.
* 🐺 **Werewolves:** The secret villains. They wake up together each night and silently pick one player to eliminate. During the day, they blend in and pretend to be innocent Villagers.
* 🩺 **Doctor:** The protector. Wakes up each night and chooses one player to save. If the Werewolves target that person, they are saved and stay in the game!
* 🔮 **Seer:** The detective. Inspects one living player privately before Day 1, then wakes up each night to inspect one player. The Moderator secretly reveals if that person is a Werewolf or innocent.
* 🏹 **Hunter:** The village's last-shot defender. Has no night action, but when eliminated by a vote or the Werewolves, chooses one living player to eliminate with a final shot.

The Doctor, Seer, and Hunter are all on the village team. Special roles are randomly selected, so not every game includes every role.

---

### Hunter (Chat Game)

The **Hunter** is on the village team and replaces one Villager in the chat roster. They have no night action. When eliminated by a vote or the Werewolves, they must choose one living player to eliminate with a final shot using their DM buttons. A saved Hunter does not shoot. The shot cannot be protected by the Doctor.

Play pauses and victory checks wait until the shot is taken, even if the Hunter's death would give the wolves parity. After the shot, check for a winner; otherwise continue to night after a daytime elimination, or the next numbered day after a nighttime elimination. The Hunter then becomes a spectator.

## How to Play

After roles are assigned privately, a game with a Seer starts with a **Seer-only opening** before Day 1. The Seer uses DM buttons to inspect one living player (including themselves); only the Seer receives whether that player is a Werewolf or innocent, not the exact innocent role. The choice is final and immediately begins **Day 1**, with everyone alive. There are no Werewolf attacks, Doctor protection, or votes during the opening; everyone else waits. DM `status` recovers the Seer's private inspection history, labeled **Opening**, and any current prompt.

Without a Seer, the game starts directly with **Day 1**. Players discuss and vote before the first normal night. Play then alternates **Day 1 → Night 1 → Day 2 → Night 2**, until one team wins. The opening inspection does not use up the Seer's Night 1 action.

### 1. Day Phase (Eyes Open)

1. **Opening Day:** The Moderator announces that the game has begun. Everyone is alive and there is no overnight report on Day 1.
2. **Later Mornings:** The Moderator announces what happened during the preceding night:
   * *If saved:* "The Werewolves attacked Alex, but the Doctor saved them! No one was eliminated."
   * *If not saved:* "Sadly, Jamie was eliminated by the Werewolves!" *(Jamie silently shows their card and becomes a quiet spectator).*
3. **Town Discussion:** Players discuss who seems suspicious, who might be lying, or what clues were spotted. Voting is available throughout the day, including Day 1.
4. **The Vote:**
   * In the game channel, a living player votes with **`@werewolf vote @player`**, mentioning the player they suspect.
   * Each living player has one vote. Repeating the command with a different target changes that vote until a majority is reached.
   * As soon as **more than half of the living players** vote for the same player (for example, 4 of 7 or 4 of 6), that player is eliminated and their role is revealed. There is no need to wait for everyone to vote.
   * A split vote keeps the day open for discussion and vote changes. Votes reset each day.
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

In chat, living night roles can submit their choices in any order. The night resolves after all have acted, so a player targeted by the Werewolves still gets their night action. If the Werewolves disagree, only the pack chooses again; protection and inspection choices remain in place.

After the night actions resolve, check for a winner. If the game continues, begin the next numbered day.

---

## How to Win

* 🧑‍🌾 **Village Team Wins:** When all Werewolves have been successfully eliminated! Villagers, the Doctor, the Seer, and the Hunter win together.
* 🐺 **Werewolves Win:** When the number of living Werewolves equals or exceeds the number of all other living players, including special village roles.

If the Hunter has a final shot pending, resolve it before checking either victory condition.

---

## Quick Tips for Playing with Kids

1. **Keep it Light:** Remind eliminated players that they are still part of the fun as "ghost observers."
2. **Prevent Peeking:** Ask kids to tap their knees gently on their lap during the night phase to create noise and disguise movement.
3. **Short Debates:** Set a 3-minute timer for the daytime discussion to keep the game moving fast!
