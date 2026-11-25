// A revision refresh never cancels the same query already in flight. Multiple
// revisions collapse into one follow-up; query changes still own their abort.
export function coalescedRefresh(load){
  let task=null,pending=false,closed=false;
  return {
    refresh(){
      if(closed)return Promise.resolve();
      pending=true;
      if(!task)task=Promise.resolve().then(async()=>{
        while(pending&&!closed){pending=false;await load();}
      }).finally(()=>{task=null;});
      return task;
    },
    close(){closed=true;pending=false;},
  };
}
